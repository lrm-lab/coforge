import { useId, type ReactNode } from "react";
import type {
    ButtonProps as AriaButtonProps,
    TooltipProps as AriaTooltipProps,
    TooltipTriggerComponentProps as AriaTooltipTriggerComponentProps,
} from "react-aria-components";
import { Button as AriaButton, OverlayArrow as AriaOverlayArrow, Tooltip as AriaTooltip, TooltipTrigger as AriaTooltipTrigger } from "react-aria-components";
import { useTooltipGroup } from "#src/components/ui/tooltip-group";
import { cx } from "#src/utils/cx";

interface TooltipProps extends AriaTooltipTriggerComponentProps, Omit<AriaTooltipProps, "children"> {
    title: ReactNode;
    description?: ReactNode;
    arrow?: boolean;
    delay?: number;
}

export const Tooltip = ({
    title,
    description,
    children,
    arrow = false,
    delay = 500,
    closeDelay = 0,
    trigger,
    isDisabled,
    isOpen,
    defaultOpen,
    offset = 6,
    crossOffset,
    placement = "top",
    onOpenChange,
    ...tooltipProps
}: TooltipProps) => {
    const group = useTooltipGroup();
    const itemId = useId();
    const isGrouped = group !== null && isOpen === undefined && defaultOpen === undefined;
    const isTopOrBottomLeft = ["top left", "top end", "bottom left", "bottom end"].includes(placement);
    const isTopOrBottomRight = ["top right", "top start", "bottom right", "bottom start"].includes(placement);
    const calculatedCrossOffset = isTopOrBottomLeft ? -12 : isTopOrBottomRight ? 12 : 0;

    const resolvedIsOpen = isGrouped ? group.activeId === itemId : isOpen;
    const resolvedDelay = isGrouped ? 0 : delay;
    const resolvedCloseDelay = isGrouped ? 0 : closeDelay;
    const skipEnterMotion = isGrouped && group.instant;
    const skipExitMotion = isGrouped && group.activeId !== null && group.activeId !== itemId;

    const handleOpenChange = (nextOpen: boolean) => {
        if (isGrouped) {
            if (nextOpen) {
                group.onTriggerOpenRequest(itemId, group.isKeyboardModality());
            } else {
                group.onTriggerCloseRequest(itemId, group.isKeyboardModality());
            }
        }
        onOpenChange?.(nextOpen);
    };

    return (
        <AriaTooltipTrigger
            {...{
                trigger,
                delay: resolvedDelay,
                closeDelay: resolvedCloseDelay,
                isDisabled,
                isOpen: resolvedIsOpen,
                defaultOpen,
                onOpenChange: handleOpenChange,
            }}
        >
            {children}

            <AriaTooltip
                {...tooltipProps}
                offset={offset}
                placement={placement}
                crossOffset={crossOffset ?? calculatedCrossOffset}
                className={({ isEntering, isExiting }) =>
                    cx(
                        "pointer-events-none",
                        isEntering && !skipEnterMotion && "motion-label-enter animate-in fade-in",
                        isExiting && !skipExitMotion && "motion-label-leave animate-out fade-out",
                    )
                }
            >
                {({ isEntering, isExiting }) => (
                    <div
                        className={cx(
                            "pointer-events-none z-50 flex max-w-[min(20rem,calc(100vw-1.5rem))] origin-(--trigger-anchor-point) flex-col items-start gap-1 rounded-lg bg-primary-solid px-3 shadow-lg",
                            description ? "py-3" : "py-2",
                            isEntering && !skipEnterMotion && "motion-label-enter animate-in fade-in",
                            isExiting && !skipExitMotion && "motion-label-leave animate-out fade-out",
                        )}
                    >
                        <span className="max-w-full min-w-0 text-xs font-semibold wrap-anywhere text-white">{title}</span>

                        {description && <span className="max-w-full min-w-0 text-xs font-medium wrap-anywhere text-tooltip-supporting-text">{description}</span>}

                        {arrow && (
                            <AriaOverlayArrow>
                                <svg
                                    viewBox="0 0 100 100"
                                    className="size-2.5 fill-bg-primary-solid in-placement-left:-rotate-90 in-placement-right:rotate-90 in-placement-top:rotate-0 in-placement-bottom:rotate-180"
                                >
                                    <path d="M0,0 L35.858,35.858 Q50,50 64.142,35.858 L100,0 Z" />
                                </svg>
                            </AriaOverlayArrow>
                        )}
                    </div>
                )}
            </AriaTooltip>
        </AriaTooltipTrigger>
    );
};

interface TooltipTriggerProps extends AriaButtonProps {}

export const TooltipTrigger = ({ children, className, ...buttonProps }: TooltipTriggerProps) => {
    return (
        <AriaButton {...buttonProps} className={(values) => cx("h-max w-max outline-hidden", typeof className === "function" ? className(values) : className)}>
            {children}
        </AriaButton>
    );
};
