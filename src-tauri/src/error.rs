use std::panic::{AssertUnwindSafe, catch_unwind};

use serde::Serialize;

/// Stable error categories that the interface can branch on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    Internal,
}

/// The error every command returns, serialized as `{ kind, message }`.
#[derive(Debug, Serialize)]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
}

/// Runs command logic and turns a panic into an `Internal` error, so a panic never crosses the IPC boundary.
///
/// The panic payload is not forwarded because it can contain internal details.
/// `AssertUnwindSafe` is acceptable because a panicking command's result is discarded;
/// state shared through `std::sync::Mutex` is still marked as poisoned.
pub fn guard<T>(command: impl FnOnce() -> Result<T, AppError>) -> Result<T, AppError> {
    catch_unwind(AssertUnwindSafe(command)).unwrap_or_else(|_| {
        Err(AppError {
            kind: ErrorKind::Internal,
            message: "An unexpected internal error occurred.".to_owned(),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn internal(message: &str) -> AppError {
        AppError {
            kind: ErrorKind::Internal,
            message: message.to_owned(),
        }
    }

    #[test]
    fn app_error_serializes_to_kind_and_message() {
        let value = serde_json::to_value(internal("disk on fire")).unwrap();

        assert_eq!(
            value,
            json!({ "kind": "internal", "message": "disk on fire" })
        );
    }

    #[test]
    fn guard_returns_the_command_value() {
        assert_eq!(guard(|| Ok(42)).unwrap(), 42);
    }

    #[test]
    fn guard_passes_the_command_error_through() {
        let error = guard::<()>(|| Err(internal("expected failure"))).unwrap_err();

        assert_eq!(error.kind, ErrorKind::Internal);
        assert_eq!(error.message, "expected failure");
    }

    #[test]
    fn guard_turns_a_panic_into_an_internal_error() {
        let error = guard::<()>(|| panic!("boom")).unwrap_err();

        assert_eq!(error.kind, ErrorKind::Internal);
        assert!(!error.message.contains("boom"));
    }
}
