//! Page-locked storage for the vault's long-lived keys (ARCHITECTURE §5.9).
//!
//! The VMK and its subkeys live in a single page-aligned page that is
//! `VirtualLock`ed on Windows, so it is never written to the page file. It is zeroized
//! (and unlocked) on drop. On other platforms the page is not locked; efre ships on
//! Windows only and other targets exist to run the test suite.

use hkdf::Hkdf;
use sha2::Sha256;
use subtle::ConstantTimeEq;
use zeroize::Zeroize;

use crate::crypto::{KEY_LEN, LBL_DATA, LBL_HEADER, LBL_MANIFEST, fill_random};
use crate::error::Result;

const PAGE_SIZE: usize = 4096;

#[repr(C, align(4096))]
struct Page([u8; PAGE_SIZE]);

/// One zero-initialised, page-aligned page, locked in RAM where the OS supports it.
struct LockedPage {
    page: Box<Page>,
    locked: bool,
}

impl LockedPage {
    fn new() -> Self {
        let page = Box::new(Page([0u8; PAGE_SIZE]));
        let locked = os::lock(&page.0);
        Self { page, locked }
    }
}

impl Drop for LockedPage {
    fn drop(&mut self) {
        self.page.0.zeroize();
        if self.locked {
            os::unlock(&self.page.0);
        }
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
mod os {
    use core::ffi::c_void;

    use windows::Win32::System::Memory::{VirtualLock, VirtualUnlock};

    pub(super) fn lock(page: &[u8; super::PAGE_SIZE]) -> bool {
        // SAFETY: `page` is a live, page-aligned allocation of exactly PAGE_SIZE bytes
        // owned by the caller; VirtualLock only changes its residency.
        unsafe { VirtualLock(page.as_ptr().cast::<c_void>(), page.len()) }.is_ok()
    }

    pub(super) fn unlock(page: &[u8; super::PAGE_SIZE]) {
        // SAFETY: as above; the range was locked by `lock`.
        let _ = unsafe { VirtualUnlock(page.as_ptr().cast::<c_void>(), page.len()) };
    }
}

#[cfg(not(windows))]
mod os {
    pub(super) fn lock(_page: &[u8; super::PAGE_SIZE]) -> bool {
        false
    }

    pub(super) fn unlock(_page: &[u8; super::PAGE_SIZE]) {}
}

const VMK: core::ops::Range<usize> = 0..KEY_LEN;
const DATA: core::ops::Range<usize> = KEY_LEN..2 * KEY_LEN;
const HEADER: core::ops::Range<usize> = 2 * KEY_LEN..3 * KEY_LEN;
const MANIFEST: core::ops::Range<usize> = 3 * KEY_LEN..4 * KEY_LEN;

/// The VMK and the keys derived from it (ARCHITECTURE §5.3).
pub(crate) struct VaultKeys {
    page: LockedPage,
}

impl VaultKeys {
    /// A fresh VMK from the OS CSPRNG, with its subkeys.
    pub(crate) fn generate() -> Result<Self> {
        let mut page = LockedPage::new();
        fill_random(&mut page.page.0[VMK])?;
        Ok(Self::derive(page))
    }

    /// Keys for an existing VMK (just unwrapped from a key slot).
    pub(crate) fn from_vmk(vmk: &[u8; KEY_LEN]) -> Self {
        let mut page = LockedPage::new();
        page.page.0[VMK].copy_from_slice(vmk);
        Self::derive(page)
    }

    fn derive(mut page: LockedPage) -> Self {
        let (vmk, rest) = page.page.0.split_at_mut(KEY_LEN);
        let hkdf = Hkdf::<Sha256>::new(None, vmk);
        for (label, range) in [
            (LBL_DATA, DATA),
            (LBL_HEADER, HEADER),
            (LBL_MANIFEST, MANIFEST),
        ] {
            let out = &mut rest[range.start - KEY_LEN..range.end - KEY_LEN];
            hkdf.expand(label, out)
                .unwrap_or_else(|_| unreachable!("32 bytes is a valid HKDF-SHA256 output length"));
        }
        Self { page }
    }

    fn key(&self, range: core::ops::Range<usize>) -> &[u8; KEY_LEN] {
        self.page.page.0[range]
            .try_into()
            .unwrap_or_else(|_| unreachable!("key ranges are KEY_LEN long"))
    }

    pub(crate) fn vmk(&self) -> &[u8; KEY_LEN] {
        self.key(VMK)
    }

    pub(crate) fn data_key(&self) -> &[u8; KEY_LEN] {
        self.key(DATA)
    }

    pub(crate) fn header_mac_key(&self) -> &[u8; KEY_LEN] {
        self.key(HEADER)
    }

    pub(crate) fn manifest_key(&self) -> &[u8; KEY_LEN] {
        self.key(MANIFEST)
    }

    /// Constant-time VMK comparison (used to confirm a fresh assertion, §6.3).
    pub(crate) fn same_vmk(&self, other: &[u8; KEY_LEN]) -> bool {
        self.vmk().ct_eq(other).into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subkeys_are_distinct_and_deterministic() {
        let a = VaultKeys::generate().unwrap();
        let b = VaultKeys::from_vmk(a.vmk());
        assert_eq!(a.data_key(), b.data_key());
        assert_eq!(a.header_mac_key(), b.header_mac_key());
        assert_eq!(a.manifest_key(), b.manifest_key());
        let keys = [a.vmk(), a.data_key(), a.header_mac_key(), a.manifest_key()];
        for (i, x) in keys.iter().enumerate() {
            for y in &keys[i + 1..] {
                assert_ne!(x, y);
            }
        }
        assert!(a.same_vmk(b.vmk()));
        assert!(!a.same_vmk(&[0u8; KEY_LEN]));
    }

    #[test]
    fn subkeys_match_rfc5869_hkdf() {
        // Independent recomputation with the hkdf crate's two-step API.
        let vmk = [0x42u8; KEY_LEN];
        let keys = VaultKeys::from_vmk(&vmk);
        let (_, hk) = Hkdf::<Sha256>::extract(Some(&[0u8; 32]), &vmk);
        let mut expected = [0u8; KEY_LEN];
        hk.expand(b"efre/v1/data", &mut expected).unwrap();
        assert_eq!(keys.data_key(), &expected);
    }

    #[test]
    fn page_is_page_aligned() {
        let keys = VaultKeys::generate().unwrap();
        assert_eq!(keys.page.page.0.as_ptr() as usize % PAGE_SIZE, 0);
    }
}
