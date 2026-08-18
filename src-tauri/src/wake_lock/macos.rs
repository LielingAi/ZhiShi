//! macOS wake-lock implementation via IOKit `IOPMAssertion`.
//!
//! Uses `kIOPMAssertionTypePreventUserIdleSystemSleep` (the current
//! Apple-recommended assertion; supersedes the deprecated
//! `kIOPMAssertionTypeNoIdleSleep` from 10.7 onward). Prevents idle sleep
//! only — closing the lid still sleeps the machine.
//!
//! See Apple's IOKit/pwr_mgt/IOPMLib.h docs.

use std::ffi::{c_char, c_void, CString};
use std::ptr;

use crate::{ulog_debug, ulog_warn};

// ─── CoreFoundation FFI (minimal, hand-rolled) ──────────────────────────────
//
// We need exactly two CFString objects (assertion type + reason) per
// acquire. Pulling in the full `core-foundation` crate just for that would
// add ~10 transitive deps; hand-rolling the two calls we need is ~15 lines
// and zero new dependencies.

type CFStringRef = *const c_void;
type CFAllocatorRef = *const c_void;

const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringCreateWithCString(
        alloc: CFAllocatorRef,
        c_str: *const c_char,
        encoding: u32,
    ) -> CFStringRef;
    fn CFRelease(cf: *const c_void);
}

// ─── IOKit FFI ──────────────────────────────────────────────────────────────

type IOPMAssertionID = u32;
type IOPMAssertionLevel = u32;
type IOReturn = i32;

const K_IO_PM_ASSERTION_LEVEL_ON: IOPMAssertionLevel = 255;
const K_IO_RETURN_SUCCESS: IOReturn = 0;

#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOPMAssertionCreateWithName(
        assertion_type: CFStringRef,
        assertion_level: IOPMAssertionLevel,
        assertion_name: CFStringRef,
        assertion_id: *mut IOPMAssertionID,
    ) -> IOReturn;

    fn IOPMAssertionRelease(assertion_id: IOPMAssertionID) -> IOReturn;
}

// Apple's assertion-type constant value (string literal in the SDK header).
const ASSERTION_TYPE_NAME: &str = "PreventUserIdleSystemSleep";

// ─── PlatformImpl ───────────────────────────────────────────────────────────

pub struct PlatformImpl {
    assertion_id: IOPMAssertionID,
}

impl PlatformImpl {
    pub fn acquire(reason: &str) -> Result<Self, String> {
        // Create CFString for assertion type. Static literal, safe to
        // unwrap CString::new since it has no interior NUL.
        let type_cstr = CString::new(ASSERTION_TYPE_NAME)
            .expect("ASSERTION_TYPE_NAME has no interior NUL");
        // Reason may contain unexpected content; sanitize NULs.
        let reason_cstr = CString::new(reason.replace('\0', ""))
            .map_err(|e| format!("reason has interior NUL: {e}"))?;

        // SAFETY: CFStringCreateWithCString accepts a null allocator (uses
        // default), a valid C string pointer, and a known UTF-8 encoding
        // constant. Returns NULL on failure, which we check below.
        let type_cf = unsafe {
            CFStringCreateWithCString(
                ptr::null(),
                type_cstr.as_ptr(),
                K_CF_STRING_ENCODING_UTF8,
            )
        };
        if type_cf.is_null() {
            return Err("CFStringCreateWithCString(type) returned null".to_string());
        }

        let name_cf = unsafe {
            CFStringCreateWithCString(
                ptr::null(),
                reason_cstr.as_ptr(),
                K_CF_STRING_ENCODING_UTF8,
            )
        };
        if name_cf.is_null() {
            // Release the already-allocated type string before bailing.
            unsafe { CFRelease(type_cf) };
            return Err("CFStringCreateWithCString(name) returned null".to_string());
        }

        let mut assertion_id: IOPMAssertionID = 0;
        // SAFETY: All four arguments are valid: two CFStringRefs we just
        // created and null-checked, a known level constant, and a valid
        // out-pointer to a stack u32.
        let result = unsafe {
            IOPMAssertionCreateWithName(
                type_cf,
                K_IO_PM_ASSERTION_LEVEL_ON,
                name_cf,
                &mut assertion_id,
            )
        };

        // The CFStrings are retained internally by IOKit, so we release our
        // local references regardless of outcome.
        unsafe {
            CFRelease(type_cf);
            CFRelease(name_cf);
        }

        if result != K_IO_RETURN_SUCCESS {
            return Err(format!("IOPMAssertionCreateWithName failed: {result}"));
        }

        ulog_debug!(
            "[wake-lock] macOS assertion acquired: id={} reason={:?}",
            assertion_id,
            reason
        );

        Ok(Self { assertion_id })
    }
}

impl Drop for PlatformImpl {
    fn drop(&mut self) {
        // SAFETY: assertion_id was set by a successful
        // IOPMAssertionCreateWithName call in `acquire`.
        let result = unsafe { IOPMAssertionRelease(self.assertion_id) };
        if result == K_IO_RETURN_SUCCESS {
            ulog_debug!("[wake-lock] macOS assertion released: id={}", self.assertion_id);
        } else {
            // Release failure is non-actionable — log and move on. The
            // assertion will eventually clear when the process exits.
            ulog_warn!(
                "[wake-lock] IOPMAssertionRelease failed: id={} ret={}",
                self.assertion_id,
                result
            );
        }
    }
}
