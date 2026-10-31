use std::io;
use std::panic::{AssertUnwindSafe, catch_unwind};

use serde::Serialize;

/// Stable error categories that the interface can branch on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    Internal,
    NoWorld,
    InvalidPath,
    NotFound,
    NotUtf8,
    WorldMissing,
    Io,
    Conflict,
}

/// The error every command returns, serialized as `{ kind, message }`.
#[derive(Debug, Serialize)]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

/// An `io` error with a plain reason for the common causes and the OS text otherwise.
impl From<io::Error> for AppError {
    fn from(error: io::Error) -> Self {
        // Windows reports a file that another program holds open as a sharing (32) or lock (33)
        // violation, which std maps to no specific kind.
        let busy = cfg!(windows) && matches!(error.raw_os_error(), Some(32 | 33));
        let message = match error.kind() {
            _ if busy => "Another program is using the file.".to_owned(),
            io::ErrorKind::ResourceBusy => "Another program is using the file.".to_owned(),
            io::ErrorKind::PermissionDenied => "Permission denied.".to_owned(),
            io::ErrorKind::StorageFull => "The disk is full.".to_owned(),
            io::ErrorKind::ReadOnlyFilesystem => "The disk is read-only.".to_owned(),
            _ => error.to_string(),
        };
        Self::new(ErrorKind::Io, message)
    }
}

/// Runs command logic and turns a panic into an `Internal` error, so a panic never crosses the IPC boundary.
///
/// The panic payload is not forwarded because it can contain internal details.
/// `AssertUnwindSafe` is acceptable because a panicking command's result is discarded;
/// state shared through `std::sync::Mutex` is still marked as poisoned.
pub fn guard<T>(command: impl FnOnce() -> Result<T, AppError>) -> Result<T, AppError> {
    catch_unwind(AssertUnwindSafe(command)).unwrap_or_else(|_| {
        Err(AppError::new(
            ErrorKind::Internal,
            "An unexpected internal error occurred.",
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn internal(message: &str) -> AppError {
        AppError::new(ErrorKind::Internal, message)
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
    fn io_errors_become_io_with_a_plain_reason() {
        let denied = AppError::from(io::Error::from(io::ErrorKind::PermissionDenied));
        assert_eq!(denied.kind, ErrorKind::Io);
        assert_eq!(denied.message, "Permission denied.");

        let full = AppError::from(io::Error::from(io::ErrorKind::StorageFull));
        assert_eq!(full.message, "The disk is full.");

        let other = AppError::from(io::Error::other("cable unplugged"));
        assert_eq!(other.kind, ErrorKind::Io);
        assert_eq!(other.message, "cable unplugged");
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_sharing_violation_says_another_program_uses_the_file() {
        let error = AppError::from(io::Error::from_raw_os_error(32));
        assert_eq!(error.message, "Another program is using the file.");
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
