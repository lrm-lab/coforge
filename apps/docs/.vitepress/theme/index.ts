// The default theme without its Inter files: `fonts/` holds subsets cut to what this site uses
// (`scripts/subset-fonts.py`).
import DefaultTheme from "vitepress/theme-without-fonts";
import "./fonts/fonts.css";
import "./punctuation.css";

export default DefaultTheme;
