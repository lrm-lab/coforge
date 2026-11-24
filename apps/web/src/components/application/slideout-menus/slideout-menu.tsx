import { useContext, type ComponentPropsWithRef, type ReactNode, type RefAttributes } from "react";
import type {
    DialogProps as AriaDialogProps,
    ModalOverlayProps as AriaModalOverlayProps,
    ModalRenderProps as AriaModalRenderProps,
} from "react-aria-components";
import {
    Dialog as AriaDialog,
    DialogTrigger as AriaDialogTrigger,
    Modal as AriaModal,
    ModalOverlay as AriaModalOverlay,
    OverlayTriggerStateContext,
} from "react-aria-components";
import { useOverlayTriggerState } from "react-stately";
import { CloseButton } from "#src/components/base/buttons/close-button";
import { PageCoordinateScrim } from "#src/components/ui/modal";
import { cx } from "#src/utils/cx";

interface ModalOverlayProps extends AriaModalOverlayProps, RefAttributes<HTMLDivElement> {}

export const ModalOverlay = (props: ModalOverlayProps) => {
    const trigger = useContext(OverlayTriggerStateContext);
    const usesLocalState = props.isOpen !== undefined || props.defaultOpen !== undefined || !trigger;
    const localState = useOverlayTriggerState({
        isOpen: props.isOpen,
        defaultOpen: props.defaultOpen,
        onOpenChange: props.onOpenChange,
    });
    const overlayState = usesLocalState ? localState : trigger;
    const open = overlayState.isOpen;
    return (
        <>
            <PageCoordinateScrim open={open} className="bg-modal-scrim/70 motion-enter animate-in fade-in" />
            <AriaModalOverlay
                {...props}
                isOpen={usesLocalState ? overlayState.isOpen : undefined}
                defaultOpen={undefined}
                onOpenChange={usesLocalState ? overlayState.setOpen : props.onOpenChange}
                className={(state) =>
                    cx(
                        /* Safari 26+: hide the fixed overlay shell and let PageCoordinateScrim dim in page coordinates. */
                        "invisible fixed inset-0 z-50 flex min-h-dvh w-full items-center justify-end bg-transparent pl-6 outline-hidden md:pl-10",
                        state.isEntering && "motion-enter animate-in fade-in",
                        state.isExiting && "motion-leave animate-out fade-out",
                        typeof props.className === "function" ? props.className(state) : props.className,
                    )
                }
            />
        </>
    );
};
ModalOverlay.displayName = "ModalOverlay";

interface ModalProps extends AriaModalOverlayProps, RefAttributes<HTMLDivElement> {}

export const Modal = (props: ModalProps) => (
    <AriaModal
        {...props}
        className={(state) =>
            cx(
                "visible inset-y-0 right-0 h-full w-full max-w-100 pb-safe-bottom shadow-xl transition",
                state.isEntering && "motion-enter animate-in slide-in-from-right",
                state.isExiting && "motion-leave animate-out slide-out-to-right",
                typeof props.className === "function" ? props.className(state) : props.className,
            )
        }
    />
);
Modal.displayName = "Modal";

interface DialogProps extends AriaDialogProps, RefAttributes<HTMLElement> {}

export const Dialog = (props: DialogProps) => (
    <AriaDialog
        role="dialog"
        aria-label="Slideout menu"
        {...props}
        className={cx(
            "relative flex size-full flex-col items-start gap-6 overflow-y-auto bg-primary ring-1 ring-secondary_alt outline-hidden",
            props.className,
        )}
    />
);
Dialog.displayName = "Dialog";

interface SlideoutMenuProps extends Omit<AriaModalOverlayProps, "children">, RefAttributes<HTMLDivElement> {
    children: ReactNode | ((children: AriaModalRenderProps & { close: () => void }) => ReactNode);
    dialogClassName?: string;
}

const Menu = ({ children, dialogClassName, ...props }: SlideoutMenuProps) => {
    return (
        <ModalOverlay {...props}>
            <Modal className={(state) => cx(typeof props.className === "function" ? props.className(state) : props.className)}>
                {(state) => (
                    <Dialog className={dialogClassName}>
                        {({ close }) => {
                            return typeof children === "function" ? children({ ...state, close }) : children;
                        }}
                    </Dialog>
                )}
            </Modal>
        </ModalOverlay>
    );
};
Menu.displayName = "SlideoutMenu";

const Content = ({ role = "region", ...props }: ComponentPropsWithRef<"div">) => {
    return <div role={role} {...props} className={cx("flex size-full flex-col gap-6 overflow-y-auto overscroll-auto px-4 md:px-6", props.className)} />;
};
Content.displayName = "SlideoutContent";

interface SlideoutHeaderProps extends ComponentPropsWithRef<"header"> {
    onClose?: () => void;
}

const Header = ({ className, children, onClose, ...props }: SlideoutHeaderProps) => {
    return (
        <header {...props} className={cx("relative z-1 w-full px-4 pt-6 md:px-6", className)}>
            {children}
            <CloseButton size="sm" className="absolute top-3 right-3 shrink-0" onClick={onClose} />
        </header>
    );
};
Header.displayName = "SlideoutHeader";

const Footer = (props: ComponentPropsWithRef<"footer">) => {
    return <footer {...props} className={cx("w-full p-4 shadow-[inset_0px_1px_0px_0px] shadow-border-secondary md:px-6", props.className)} />;
};
Footer.displayName = "SlideoutFooter";

const SlideoutMenu = Menu as typeof Menu & {
    Trigger: typeof AriaDialogTrigger;
    Content: typeof Content;
    Header: typeof Header;
    Footer: typeof Footer;
};
SlideoutMenu.displayName = "SlideoutMenu";

SlideoutMenu.Trigger = AriaDialogTrigger;
SlideoutMenu.Content = Content;
SlideoutMenu.Header = Header;
SlideoutMenu.Footer = Footer;

export { SlideoutMenu };
