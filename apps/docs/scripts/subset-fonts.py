# /// script
# requires-python = "==3.13.*"
# dependencies = ["fonttools[woff]==4.68.0"]
# ///
"""Cut the docs site's Inter down to what the built site uses.

Run by hand from apps/docs, after the content or CSS changes in a way `test/site.test.ts` reports:

    mise exec uv@0.11.7 -- uv run scripts/subset-fonts.py

It builds the site, reads which characters the pages use, and writes four woff2 files and
`fonts.css` into `.vitepress/theme/fonts/`. Commit what it writes. Each style gets a core, which
the roman style preloads, and an extended file behind `unicode-range` that a page downloads only
when it uses one of its characters.

The core holds what VitePress's Latin face held (ASCII, Latin-1, the punctuation pages use) and the
extended file the rest. Kerning and contextual alternates never apply across two @font-face files,
so splitting where VitePress already split keeps every pair that shapes together today shaping
together. A core of ASCII and punctuation alone would be 10.5 KB smaller, but would drop the kerning
between an ASCII letter and a Latin-1 one ("café", "Té"), moving the rest of such a line by about
a pixel.

The source is the Inter 4.0 release VitePress cut its own subsets from (same version string,
4.000;git-a52131595). Only characters VitePress's Inter faces cover are kept, so a character that
falls back to a system font today (CJK, `→`) keeps doing so.
"""

import hashlib
import html
import io
import re
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

INTER_ZIP_URL = "https://github.com/rsms/inter/releases/download/v4.0/Inter-4.0.zip"
INTER_ZIP_SHA256 = "ff970a5d4561a04f102a7cb781adbd6ac4e9b6c460914c7a101f15acb7f7d1a4"
# Style name in the output files, source file, CSS font-style.
STYLES = [("roman", "InterVariable.ttf", "normal"), ("italic", "InterVariable-Italic.ttf", "italic")]

# The built CSS asks for 400, 500, 600 and 700, and the UA's `bold` for strong, b, th and headings
# is 700; `font-synthesis: style` on body rules out synthetic bold. Only the light end is cut: 400
# is the default master, so dropping 100-399 leaves every delta above it as it was, while cutting
# 701-900 would rescale the Black master's deltas and round them back to integers, moving outlines
# by up to 2 units and advances by 1 at 500-700; keeping them costs about 1.7 KB a file. opsz is left whole
# because `font-optical-sizing: auto` maps the site's 10-64px font sizes onto all of 14-32.
WEIGHTS = (400, 900)
# limit_weight keeps gvar verbatim, which is exact only when the new minimum is the default master.
assert WEIGHTS[0] == 400
# Inter's other features are off by default and nothing in the CSS turns them on. Its `locl` only
# has Catalan, Moldavian and Romanian forms, and the site is English and Chinese.
LAYOUT_FEATURES = ["ccmp", "calt", "kern", "mark", "mkmk"]

# Kept whether or not a page uses them yet. U+200B is in every heading anchor. U+2010 is the hyphen
# the browser draws at a soft-hyphen or `hyphens: auto` break, and U+2026 the
# `text-overflow: ellipsis` the sidebar and nav use.
ALWAYS_KEPT = (
    set(range(0x20, 0x7F))
    | set(range(0xA0, 0x180))
    | {0x200B, 0x2010, 0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026}
)

DOCS = Path(__file__).resolve().parent.parent
DIST = DOCS / ".vitepress/dist"
OUT = DOCS / ".vitepress/theme/fonts"
VITEPRESS_FONTS_CSS = DOCS / "node_modules/vitepress/dist/client/theme-default/styles/fonts.css"


def download_inter() -> zipfile.ZipFile:
    with urllib.request.urlopen(INTER_ZIP_URL) as response:
        data = response.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != INTER_ZIP_SHA256:
        sys.exit(f"{INTER_ZIP_URL} has SHA-256 {digest}, expected {INTER_ZIP_SHA256}")
    return zipfile.ZipFile(io.BytesIO(data))


def parse_unicode_range(value: str) -> set[int]:
    points: set[int] = set()
    for start, end in re.findall(r"U\+([0-9A-F]+)(?:-([0-9A-F]+))?", value, re.I):
        points.update(range(int(start, 16), int(end or start, 16) + 1))
    return points


def vitepress_inter_ranges(css: str) -> list[set[int]]:
    return [
        parse_unicode_range(re.search(r"unicode-range:([^;]+);", body).group(1))
        for body in re.findall(r"@font-face\s*{([^}]*)}", css)
        if re.search(r"font-family:\s*['\"]?Inter['\"]?\s*;", body)
    ]


def used_code_points() -> set[int]:
    points: set[int] = set()
    for path in [*DIST.rglob("*.html"), *DIST.rglob("*.js")]:
        text = path.read_text("utf-8")
        points.update(map(ord, html.unescape(text) if path.suffix == ".html" else text))
    return points


def cut(source: bytes, points: set[int]) -> TTFont:
    # Saving would stamp head.modified with the time; keeping Inter's makes reruns byte-identical.
    font = TTFont(io.BytesIO(source), recalcTimestamp=False)
    options = subset.Options()
    options.layout_features = LAYOUT_FEATURES
    options.hinting = False
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=points)
    subsetter.subset(font)
    font = limit_weight(font)
    font.flavor = "woff2"
    return font


def limit_weight(font: TTFont) -> TTFont:
    """Drop the weights below WEIGHTS[0] without moving any outline above it.

    The instancer limits fvar, avar, HVAR, MVAR and GPOS exactly, but it re-optimizes every
    glyph's gvar deltas it touches, which moves points by up to half a unit. Above the default
    master a delta that only applies below it (its wght peak and end at or under 0) contributes
    nothing, so gvar keeps the source's own variations and drops just those.
    """
    gvar = {
        glyph: [
            variation
            for variation in variations
            if not (variation.axes.get("wght", (0, 0, 0))[1] < 0 and variation.axes["wght"][2] <= 0)
        ]
        for glyph, variations in font["gvar"].variations.items()
    }
    # Not inplace: the instancer would re-optimize the very variations kept above.
    limited = instancer.instantiateVariableFont(font, {"wght": WEIGHTS})
    limited["gvar"].variations = gvar
    return limited


def css_unicode_range(points: set[int]) -> str:
    runs: list[list[int]] = []
    for point in sorted(points):
        if runs and point == runs[-1][1] + 1:
            runs[-1][1] = point
        else:
            runs.append([point, point])
    return ", ".join(f"U+{a:04X}" if a == b else f"U+{a:04X}-{b:04X}" for a, b in runs)


# Locations that check, file by file, that cutting moved no outline or advance in the kept range.
CHECKED_LOCATIONS = [
    {"wght": wght, "opsz": opsz}
    for wght in range(WEIGHTS[0], WEIGHTS[1] + 1, 100)
    for opsz in (14, 16, 20, 24, 32)
]


def verify(path: Path, points: set[int], references: list[TTFont]) -> None:
    font = TTFont(path)
    cmap = set(font.getBestCmap())
    if cmap != points:
        sys.exit(f"{path.name} maps {sorted(cmap ^ points)} unexpectedly")
    axes = {axis.axisTag: (axis.minValue, axis.maxValue) for axis in font["fvar"].axes}
    if axes != {"opsz": (14, 32), "wght": WEIGHTS}:
        sys.exit(f"{path.name} has axes {axes}")
    features = {record.FeatureTag for table in ("GSUB", "GPOS") if table in font
                for record in font[table].table.FeatureList.FeatureRecord}
    if not features <= set(LAYOUT_FEATURES):
        sys.exit(f"{path.name} keeps features {sorted(features - set(LAYOUT_FEATURES))}")
    if hinting := [tag for tag in ("fpgm", "prep", "cvt ", "hdmx", "VDMX", "LTSH") if tag in font]:
        sys.exit(f"{path.name} keeps hinting tables {hinting}")
    for location, theirs in zip(CHECKED_LOCATIONS, references):
        ours = instancer.instantiateVariableFont(font, location)
        for point in points:
            if outline(ours, point) != outline(theirs, point):
                sys.exit(f"{path.name} draws U+{point:04X} differently at {location}")


def outline(instance: TTFont, point: int) -> tuple:
    glyph = instance.getBestCmap()[point]
    return instance["hmtx"][glyph], list(instance["glyf"][glyph].getCoordinates(instance["glyf"])[0])


def font_face(path: Path, font_style: str, points: set[int]) -> str:
    return (
        "@font-face {\n"
        "  font-family: Inter;\n"
        f"  font-style: {font_style};\n"
        f"  font-weight: {WEIGHTS[0]} {WEIGHTS[1]};\n"
        "  font-display: swap;\n"
        f"  src: url('./{path.name}') format('woff2');\n"
        f"  unicode-range: {css_unicode_range(points)};\n"
        "}\n"
    )


def main() -> None:
    subprocess.run(["bun", "run", "build"], cwd=DOCS, check=True)

    archive = download_inter()
    license_text = archive.read("LICENSE.txt").decode("utf-8")
    # The OFL asks a modified font to drop any Reserved Font Name, which the copyright notice above
    # the license declares ("with Reserved Font Name ..."). Inter's reserves none, so the subsets
    # keep the name "Inter Variable".
    notice = license_text.split("SIL OPEN FONT LICENSE", 1)[0]
    if "reserved font name" in notice.lower():
        sys.exit("Inter's license now reserves a font name; rename the subsets before shipping them")

    ranges = vitepress_inter_ranges(VITEPRESS_FONTS_CSS.read_text("utf-8"))
    covered = set().union(*ranges)
    latin = set().union(*(points for points in ranges if ord("A") in points))
    used = used_code_points()
    OUT.mkdir(parents=True, exist_ok=True)
    faces: list[str] = []
    for style, name, font_style in STYLES:
        data = archive.read(name)
        source = TTFont(io.BytesIO(data))
        available = covered & set(source.getBestCmap())
        kept = (ALWAYS_KEPT | used) & available
        core = kept & latin
        extended = kept - core
        references = [instancer.instantiateVariableFont(source, location) for location in CHECKED_LOCATIONS]
        for part, points in (("core", core), ("extended", extended)):
            path = OUT / f"inter-{style}-{part}.woff2"
            cut(data, points).save(path)
            verify(path, points, references)
            faces.append(font_face(path, font_style, points))
            print(f"{path.name}: {path.stat().st_size} bytes, {len(points)} characters")

    (OUT / "LICENSE.txt").write_text(license_text, "utf-8")
    (OUT / "fonts.css").write_text(
        "/* Generated by scripts/subset-fonts.py; do not edit. */\n\n" + "\n".join(faces),
        "utf-8",
    )
    # The workspace's formatter owns CSS layout; the rest of the workspace is already formatted.
    subprocess.run(["bun", "run", "format"], cwd=DOCS, check=True)


if __name__ == "__main__":
    main()
