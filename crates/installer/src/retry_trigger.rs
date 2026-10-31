//! The one-shot trigger that runs `coforge-installer recover --auto` again after a delay, when an
//! upgrade ended with its recovery journal kept and the service stopped. It exists only while a
//! journal does: [`crate::auto_recover`] arms it when one is written and disarms it when recovery
//! settles it or gives up, so a healthy machine carries no extra scheduled work.
//!
//! One backend per service manager, beside the supervisor's own (`service`).

use std::time::Duration;

pub trait RetryTrigger {
    /// Arranges for `recover --auto` to run once, `delay` from now, replacing any earlier
    /// arrangement.
    fn schedule(&self, delay: Duration) -> Result<(), String>;

    /// Removes the arrangement. One that does not exist is not an error.
    fn cancel(&self) -> Result<(), String>;
}

/// The trigger of a platform without a backend: arranges nothing, so recovery then waits for the
/// next start of the service (`coforge-installer start` settles the journal first) or a person.
pub struct NoTrigger;

impl RetryTrigger for NoTrigger {
    fn schedule(&self, _delay: Duration) -> Result<(), String> {
        Ok(())
    }

    fn cancel(&self) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod fakes {
    use std::cell::RefCell;

    use super::*;

    /// Records what was asked of it.
    #[derive(Default)]
    pub(crate) struct FakeTrigger {
        pub(crate) calls: RefCell<Vec<String>>,
    }

    impl FakeTrigger {
        pub(crate) fn calls(&self) -> Vec<String> {
            self.calls.borrow().clone()
        }
    }

    impl RetryTrigger for FakeTrigger {
        fn schedule(&self, delay: Duration) -> Result<(), String> {
            self.calls
                .borrow_mut()
                .push(format!("schedule {}s", delay.as_secs()));
            Ok(())
        }

        fn cancel(&self) -> Result<(), String> {
            self.calls.borrow_mut().push("cancel".to_owned());
            Ok(())
        }
    }
}
