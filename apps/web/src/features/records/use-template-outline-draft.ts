import { useState } from "react";

import { FOUNDATION_MODELS_WEEKLY_SECTIONS } from "./foundation-models-weekly";
import type { TemplateOutlineSection } from "./template-outline-sections";

export function emptySection(): TemplateOutlineSection {
  return { title: "", children: [] };
}

export function foundationModelsSections(): TemplateOutlineSection[] {
  return FOUNDATION_MODELS_WEEKLY_SECTIONS.map((section) => ({
    ...section,
    children: [...section.children],
  }));
}

/** A weekly template's heading outline being edited: level-one headings, each with its
 * level-two children; removing the last heading leaves one empty one. */
export function useTemplateOutlineDraft() {
  const [sections, setSections] = useState<TemplateOutlineSection[]>(foundationModelsSections);

  function updateSectionTitle(index: number, title: string) {
    setSections((current) =>
      current.map((section, sectionIndex) =>
        sectionIndex === index ? { ...section, title } : section,
      ),
    );
  }

  function updateChildTitle(sectionIndex: number, childIndex: number, title: string) {
    setSections((current) =>
      current.map((section, index) => {
        if (index !== sectionIndex) return section;
        return {
          ...section,
          children: section.children.map((child, offset) =>
            offset === childIndex ? title : child,
          ),
        };
      }),
    );
  }

  function addSection() {
    setSections((current) => [...current, emptySection()]);
  }

  function removeSection(index: number) {
    setSections((current) => {
      const next = current.filter((_, sectionIndex) => sectionIndex !== index);
      return next.length > 0 ? next : [emptySection()];
    });
  }

  function addChild(sectionIndex: number) {
    setSections((current) =>
      current.map((section, index) =>
        index === sectionIndex ? { ...section, children: [...section.children, ""] } : section,
      ),
    );
  }

  function removeChild(sectionIndex: number, childIndex: number) {
    setSections((current) =>
      current.map((section, index) =>
        index === sectionIndex
          ? {
              ...section,
              children: section.children.filter((_, offset) => offset !== childIndex),
            }
          : section,
      ),
    );
  }

  return {
    sections,
    setSections,
    updateSectionTitle,
    updateChildTitle,
    addSection,
    removeSection,
    addChild,
    removeChild,
  };
}
