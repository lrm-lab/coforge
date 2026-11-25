import type { CSSProperties, FC, ReactElement, ReactNode, Ref } from "react";
import { isValidElement, useCallback, useRef } from "react";
import type { ButtonProps as AriaButtonProps, LinkProps as AriaLinkProps } from "react-aria-components";
import { Button as AriaButton, Link as AriaLink } from "react-aria-components";
import { useButtonLoadingTransition } from "#src/components/ui/loading";
import { Spinner } from "#src/components/ui/spinner";
import { cx, sortCx } from "#src/utils/cx";
import { isReactComponent } from "#src/utils/is-react-component";

export const styles = sortCx({
    common: {
        root: [
            "group relative inline-flex h-max cursor-pointer items-center justify-center whitespace-nowrap outline-brand transition duration-100 ease-out before:absolute focus-visible:outline-2 focus-visible:outline-offset-2",
            "in-data-input-wrapper:shadow-xs in-data-input-wrapper:focus:!z-50 in-data-input-wrapper:in-data-leading:-mr-px in-data-input-wrapper:in-data-leading:rounded-r-none in-data-input-wrapper:in-data-leading:before:rounded-r-none in-data-input-wrapper:in-data-trailing:-ml-px in-data-input-wrapper:in-data-trailing:rounded-l-none in-data-input-wrapper:in-data-trailing:before:rounded-l-none",
            "disabled:cursor-not-allowed disabled:opacity-50 in-data-input-wrapper:disabled:opacity-100",
            "*:data-icon:pointer-events-none *:data-icon:size-5 *:data-icon:shrink-0 *:data-icon:transition-inherit-all",
        ].join(" "),
        icon: "pointer-events-none size-5 shrink-0 transition-inherit-all",
    },
    sizes: {
        xs: {
            root: [
                "gap-1 rounded-lg px-2.5 py-1.5 text-sm font-semibold before:rounded-[7px] data-icon-only:p-2",
                "in-data-input-wrapper:px-3.5 in-data-input-wrapper:py-2.5 in-data-input-wrapper:data-icon-only:p-2.5",
                "*:data-icon:size-4 *:data-icon:stroke-[2.25px]",
            ].join(" "),
            linkRoot: "gap-1 *:data-text:underline-offset-3",
        },
        sm: {
            root: [
                "gap-1 rounded-lg px-3 py-2 text-sm font-semibold before:rounded-[7px] data-icon-only:p-2",
                "in-data-input-wrapper:px-3.5 in-data-input-wrapper:py-2.5 in-data-input-wrapper:data-icon-only:p-2.5",
            ].join(" "),
            linkRoot: "gap-1 *:data-text:underline-offset-3",
        },
        md: {
            root: [
                "gap-1 rounded-lg px-3.5 py-2.5 text-sm font-semibold before:rounded-[7px] data-icon-only:p-2.5",
                "in-data-input-wrapper:gap-1.5 in-data-input-wrapper:px-4 in-data-input-wrapper:text-md in-data-input-wrapper:data-icon-only:p-3",
            ].join(" "),
            linkRoot: "gap-1 *:data-text:underline-offset-4",
        },
        lg: {
            root: "gap-1.5 rounded-lg px-4 py-2.5 text-md font-semibold before:rounded-[7px] data-icon-only:p-3",
            linkRoot: "gap-1.5 *:data-text:underline-offset-4",
        },
        xl: {
            root: "gap-1.5 rounded-lg px-4.5 py-3 text-md font-semibold before:rounded-[7px] data-icon-only:p-3.5",
            linkRoot: "gap-1.5 *:data-text:underline-offset-4",
        },
    },

    colors: {
        primary: {
            root: [
                "bg-brand-solid text-white shadow-xs-skeuomorphic ring-1 ring-transparent ring-inset hover:bg-brand-solid_hover data-loading:bg-brand-solid_hover",
                "before:absolute before:inset-px before:border before:border-white/12 before:mask-b-from-0%",
                "*:data-icon:text-white/60 hover:*:data-icon:text-white/70",
            ].join(" "),
        },
        secondary: {
            root: [
                "bg-primary text-secondary shadow-xs-skeuomorphic ring-1 ring-primary ring-inset hover:bg-primary_hover hover:text-secondary_hover data-loading:bg-primary_hover",
                "*:data-icon:text-fg-quaternary hover:*:data-icon:text-fg-quaternary_hover",
            ].join(" "),
        },
        tertiary: {
            root: [
                "text-tertiary hover:bg-primary_hover hover:text-tertiary_hover",
                "*:data-icon:text-fg-quaternary hover:*:data-icon:text-fg-quaternary_hover",
            ].join(" "),
        },
        "link-color": {
            root: [
                "justify-normal rounded p-0! text-brand-secondary hover:text-brand-secondary_hover",
                "*:data-text:underline *:data-text:decoration-transparent hover:*:data-text:decoration-fg-brand-secondary_alt",
                "*:data-icon:text-fg-brand-secondary_alt hover:*:data-icon:text-fg-brand-secondary_hover",
            ].join(" "),
        },
        "link-gray": {
            root: [
                "justify-normal rounded p-0! text-tertiary hover:text-tertiary_hover",
                "*:data-text:underline *:data-text:decoration-transparent hover:*:data-text:decoration-fg-quaternary",
                "*:data-icon:text-fg-quaternary hover:*:data-icon:text-fg-quaternary_hover",
            ].join(" "),
        },
        "primary-destructive": {
            root: [
                "bg-error-solid text-white shadow-xs-skeuomorphic ring-1 ring-transparent outline-error ring-inset hover:bg-error-solid_hover data-loading:bg-error-solid_hover",
                "before:absolute before:inset-px before:border before:border-white/12 before:mask-b-from-0%",
                "*:data-icon:text-white/60 hover:*:data-icon:text-white/70",
            ].join(" "),
        },
        "secondary-destructive": {
            root: [
                "bg-primary text-error-primary shadow-xs-skeuomorphic ring-1 ring-error_subtle outline-error ring-inset hover:bg-error-primary hover:text-error-primary_hover data-loading:bg-error-primary",
                "*:data-icon:text-fg-error-secondary hover:*:data-icon:text-fg-error-primary",
            ].join(" "),
        },
        "secondary-warning": {
            root: [
                "bg-primary text-warning-strong shadow-xs-skeuomorphic ring-1 ring-warning_subtle outline-warning ring-inset hover:bg-warning-primary data-loading:bg-warning-primary",
                "*:data-icon:text-fg-warning-secondary hover:*:data-icon:text-fg-warning-primary",
            ].join(" "),
        },
        "tertiary-destructive": {
            root: [
                "text-error-primary outline-error hover:bg-error-primary hover:text-error-primary_hover",
                "*:data-icon:text-fg-error-secondary hover:*:data-icon:text-fg-error-primary",
            ].join(" "),
        },
        "link-destructive": {
            root: [
                "justify-normal rounded p-0! text-error-primary outline-error hover:text-error-primary_hover",
                "*:data-text:underline *:data-text:decoration-transparent *:data-text:underline-offset-2 hover:*:data-text:decoration-current",
                "*:data-icon:text-fg-error-secondary hover:*:data-icon:text-fg-error-primary",
            ].join(" "),
        },
    },
});

export interface CommonProps {
    isDisabled?: boolean;
    isLoading?: boolean;
    size?: keyof typeof styles.sizes;
    color?: keyof typeof styles.colors;
    iconLeading?: FC<{ className?: string }> | ReactNode;
    iconTrailing?: FC<{ className?: string }> | ReactNode;
    noTextPadding?: boolean;
    showTextWhileLoading?: boolean;

    children?: ReactNode;
    className?: string;
}

export interface ButtonProps extends CommonProps, Omit<AriaButtonProps, "children" | "className"> {}
interface LinkProps extends CommonProps, Omit<AriaLinkProps, "children" | "className"> {
    href: NonNullable<AriaLinkProps["href"]>;
}

export type Props = ButtonProps | LinkProps;

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
    if (typeof ref === "function") ref(value);
    else if (ref && "current" in ref) ref.current = value;
}

function withLockedWidth<TStyle>(style: TStyle, lockedWidth: number | null): TStyle {
    if (lockedWidth === null) return style;
    const widthStyle: CSSProperties = { width: `${lockedWidth}px` };
    if (typeof style === "function") {
        const styleFn = style as (values: unknown) => CSSProperties | undefined;
        return ((values: unknown) => ({ ...styleFn(values), ...widthStyle })) as TStyle;
    }
    return { ...(style as CSSProperties | undefined), ...widthStyle } as TStyle;
}

export const Button: {
    (props: LinkProps): ReactElement<LinkProps>;
    (props: ButtonProps): ReactElement<ButtonProps>;
} = ({
    size = "sm",
    color = "primary",
    children,
    className,
    noTextPadding,
    iconLeading: IconLeading,
    iconTrailing: IconTrailing,
    isDisabled: disabled,
    isLoading: loading,
    showTextWhileLoading: _showTextWhileLoading,
    ...props
}) => {
    const href = "href" in props ? props.href : undefined;

    const isIcon = (IconLeading || IconTrailing) && !children;
    const isLinkType = ["link-gray", "link-color", "link-destructive"].includes(color);

    noTextPadding = isLinkType || noTextPadding;

    const elementRef = useRef<HTMLElement | null>(null);
    const externalRef = "ref" in props ? (props.ref as Ref<HTMLElement> | undefined) : undefined;
    const setRef = useCallback(
        (node: HTMLElement | null) => {
            elementRef.current = node;
            assignRef(externalRef, node);
        },
        [externalRef],
    );

    const { showIndicator, loadingActive, lockedWidth, frozenContent, captureIdleWidth } =
        useButtonLoadingTransition(
            loading,
            elementRef,
            { children, iconLeading: IconLeading, iconTrailing: IconTrailing },
            [size, color, className, children, IconLeading, IconTrailing, isIcon],
        );

    const shownChildren = loadingActive && frozenContent ? frozenContent.children : children;
    const ShownIconLeading = loadingActive && frozenContent ? frozenContent.iconLeading : IconLeading;
    const ShownIconTrailing = loadingActive && frozenContent ? frozenContent.iconTrailing : IconTrailing;

    const originalOnPressStart = props.onPressStart;
    const handlePressStart = useCallback(
        (event: Parameters<NonNullable<typeof originalOnPressStart>>[0]) => {
            captureIdleWidth();
            originalOnPressStart?.(event);
        },
        [captureIdleWidth, originalOnPressStart],
    );

    const commonChildren = (
        <>
            {isValidElement(ShownIconLeading) && ShownIconLeading}
            {isReactComponent(ShownIconLeading) && <ShownIconLeading data-icon="leading" className={styles.common.icon} />}

            {loadingActive && (
                <span
                    data-loading-indicator=""
                    aria-hidden={!showIndicator || undefined}
                    className="pointer-events-none absolute inset-0 inline-flex items-center justify-center"
                >
                    <Spinner className={size === "xs" ? "size-4" : "size-5"} />
                </span>
            )}

            {shownChildren && (
                <span data-text className={cx("transition-inherit-all", !noTextPadding && "px-0.5")}>
                    {shownChildren}
                </span>
            )}

            {isValidElement(ShownIconTrailing) && ShownIconTrailing}
            {isReactComponent(ShownIconTrailing) && <ShownIconTrailing data-icon="trailing" className={styles.common.icon} />}
        </>
    );

    const commonProps = {
        "data-loading": loading ? true : undefined,
        "data-loading-active": loadingActive ? "" : undefined,
        "data-loading-visible": showIndicator ? "" : undefined,
        "data-icon-only": isIcon ? true : undefined,
        "data-press-scale": isLinkType ? undefined : true,
        ...props,
        ref: setRef,
        onPressStart: handlePressStart,
        style: withLockedWidth(props.style, lockedWidth),
        isDisabled: disabled,
        className: cx(
            styles.common.root,
            styles.sizes[size].root,
            styles.colors[color].root,
            isLinkType && styles.sizes[size].linkRoot,
            loadingActive && "overflow-hidden",
            (loading || (href && (disabled || loading))) && "pointer-events-none",
            className,
        ),
        children: commonChildren,
    };

    if ("href" in commonProps) {
        return <AriaLink {...(commonProps as AriaLinkProps)} href={disabled ? undefined : href} />;
    }

    return <AriaButton {...(commonProps as AriaButtonProps)} type={(commonProps as AriaButtonProps).type || "button"} isPending={loading} />;
};
