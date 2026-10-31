//! YubiKey presence by USB vendor id (ARCHITECTURE §8.5), platform-independent part.
//!
//! efre locks when no Yubico HID interface remains. Presence is decided from device
//! interface paths alone; no device is ever opened (so no admin rights are needed).
//! The Windows enumeration and notifications live in `presence_windows`.

/// Yubico's USB vendor id.
pub const YUBICO_VID: u16 = 0x1050;

/// `VID_1050`, the hardware-id token Windows uses for Yubico devices.
const VID_TOKEN: &str = "VID_1050";

/// True if `path` is a HID device interface path of a Yubico device.
///
/// Paths look like `\\?\HID#VID_1050&PID_0407&MI_01#7&2d1c3a&0&0000#{4d1e55b2-…}`.
/// The vendor id must appear as a whole `&`-separated token of the hardware-id
/// component (the one right after `HID#`), compared case-insensitively. A matching
/// string anywhere else in the path (instance id, class GUID) does not count.
pub fn is_yubico_interface_path(path: &str) -> bool {
    let mut parts = path.split('#');
    let (Some(prefix), Some(hardware_id)) = (parts.next(), parts.next()) else {
        return false;
    };
    let is_hid = prefix
        .rsplit('\\')
        .next()
        .is_some_and(|enumerator| enumerator.eq_ignore_ascii_case("HID"));
    is_hid
        && hardware_id
            .split('&')
            .any(|token| token.eq_ignore_ascii_case(VID_TOKEN))
}

/// True if any path in a NUL-separated, double-NUL-terminated UTF-16 list (the format
/// `CM_Get_Device_Interface_ListW` returns) is a Yubico HID interface.
pub fn any_yubico_in_multi_sz(list: &[u16]) -> bool {
    list.split(|&unit| unit == 0)
        .filter(|path| !path.is_empty())
        .any(|path| is_yubico_interface_path(&String::from_utf16_lossy(path)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const HID_GUID: &str = "{4d1e55b2-f16f-11cf-88cb-001111000030}";

    fn path(hardware_id: &str) -> String {
        format!(r"\\?\HID#{hardware_id}#7&2d1c3a&0&0000#{HID_GUID}")
    }

    fn multi_sz(paths: &[&str]) -> Vec<u16> {
        let mut out = Vec::new();
        for p in paths {
            out.extend(p.encode_utf16());
            out.push(0);
        }
        out.push(0);
        out
    }

    #[test]
    fn token_matches_vendor_constant() {
        assert_eq!(VID_TOKEN, format!("VID_{YUBICO_VID:04X}"));
    }

    #[test]
    fn recognises_yubico_interfaces() {
        for hw in [
            "VID_1050&PID_0407&MI_01",       // YubiKey 5 OTP+FIDO+CCID, FIDO interface
            "VID_1050&PID_0407&MI_00",       // its keyboard (OTP) interface
            "VID_1050&PID_0402",             // FIDO-only key, single interface
            "VID_1050&PID_0407&MI_01&Col02", // top-level collection suffix
            "vid_1050&pid_0407&mi_01",       // lower case
            "PID_0407&VID_1050",             // token order does not matter
        ] {
            assert!(is_yubico_interface_path(&path(hw)), "{hw}");
        }
        assert!(is_yubico_interface_path(&format!(
            r"\\?\hid#VID_1050&PID_0120#7&1&0&0000#{HID_GUID}"
        )));
    }

    #[test]
    fn rejects_other_devices_and_look_alikes() {
        for hw in [
            "VID_10500&PID_0407", // longer vendor id
            "VID_0105&PID_0407",  // shorter / different
            "VID_046D&PID_C52B",  // another vendor
            "XVID_1050&PID_0407", // prefixed token
            "VID_1050X&PID_0407", // suffixed token
            "VID-1050&PID_0407",  // wrong separator
            "",                   // empty hardware id
        ] {
            assert!(!is_yubico_interface_path(&path(hw)), "{hw:?}");
        }
        // The vendor string outside the hardware-id component does not count.
        assert!(!is_yubico_interface_path(&format!(
            r"\\?\HID#VID_046D&PID_C52B#7&VID_1050&0#{HID_GUID}"
        )));
        assert!(!is_yubico_interface_path(
            r"\\?\HID#VID_046D&PID_C52B#7&2d1c3a&0&0000#{VID_1050}"
        ));
        // Not a HID interface path.
        assert!(!is_yubico_interface_path(&format!(
            r"\\?\USB#VID_1050&PID_0407#0001#{HID_GUID}"
        )));
        assert!(!is_yubico_interface_path(&format!(
            r"\\?\SWD#VID_1050&PID_0407#x#{HID_GUID}"
        )));
        // Malformed.
        for bad in ["", "#", "VID_1050", r"\\?\HID", r"\\?\HID#", "HIDVID_1050"] {
            assert!(!is_yubico_interface_path(bad), "{bad:?}");
        }
    }

    #[test]
    fn multi_sz_lists() {
        let mouse = path("VID_046D&PID_C52B&MI_01");
        let yubikey = path("VID_1050&PID_0407&MI_01");
        assert!(!any_yubico_in_multi_sz(&[0]));
        assert!(!any_yubico_in_multi_sz(&[]));
        assert!(!any_yubico_in_multi_sz(&multi_sz(&[&mouse])));
        assert!(any_yubico_in_multi_sz(&multi_sz(&[&mouse, &yubikey])));
        assert!(any_yubico_in_multi_sz(&multi_sz(&[&yubikey])));
        // Missing final terminator and stray empty entries are tolerated.
        let mut unterminated: Vec<u16> = yubikey.encode_utf16().collect();
        assert!(any_yubico_in_multi_sz(&unterminated));
        unterminated.splice(0..0, [0, 0]);
        assert!(any_yubico_in_multi_sz(&unterminated));
    }
}
