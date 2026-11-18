import type { ReactNode } from "react";
import { XClose } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { PANEL_HEADER_CLASS, PANEL_TITLE_CLASS } from "./review-chrome";

export function ReviewPanelHeader({
  title,
  close,
  children,
}: {
  title: ReactNode;
  close?: { label: string; onPress: () => void };
  children?: ReactNode;
}) {
  return (
    <header className={PANEL_HEADER_CLASS}>
      <h2 className={PANEL_TITLE_CLASS}>{title}</h2>
      {children}
      {close && (
        <ButtonUtility
          icon={XClose}
          size="xs"
          color="tertiary"
          tooltip={close.label}
          onClick={close.onPress}
        />
      )}
    </header>
  );
}
