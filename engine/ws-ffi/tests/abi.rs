//! The C boundary: handles, strings and output pointers. Values are checked against
//! OWA-EPANET by `oracle/toolkit.sh`.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::ffi::{CStr, CString, c_char, c_double, c_int, c_long};
use std::ptr;

use epanet2::*;

const NET: &str = "[JUNCTIONS]\n J1 100 10\n[RESERVOIRS]\n R 200\n[PIPES]\n P1 R J1 1000 12 100\n\
[TIMES]\n Duration 2:00\n[OPTIONS]\n Units GPM\n[END]\n";

fn cstr(buf: &[c_char]) -> String {
    // SAFETY: the library always NUL-terminates what it writes.
    unsafe { CStr::from_ptr(buf.as_ptr()) }
        .to_string_lossy()
        .into_owned()
}

#[test]
fn runs_a_network_through_the_c_api() {
    let dir = std::env::temp_dir().join(format!("ws-ffi-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let inp = dir.join("net.inp");
    std::fs::write(&inp, NET).unwrap();
    let inp = CString::new(inp.to_str().unwrap()).unwrap();
    let empty = CString::new("").unwrap();

    unsafe {
        assert_eq!(EN_getcount(ptr::null_mut(), 0, ptr::null_mut()), 102);
        let mut ph: EnProject = ptr::null_mut();
        assert_eq!(EN_createproject(&mut ph), 0);
        assert!(!ph.is_null());
        assert_eq!(EN_open(ph, inp.as_ptr(), inp.as_ptr(), empty.as_ptr()), 301);
        assert_eq!(EN_open(ph, inp.as_ptr(), empty.as_ptr(), empty.as_ptr()), 0);

        let mut n: c_int = 0;
        assert_eq!(EN_getcount(ph, 0, &mut n), 0);
        assert_eq!(n, 2);
        let id = CString::new("J1").unwrap();
        let mut index: c_int = 0;
        assert_eq!(EN_getnodeindex(ph, id.as_ptr(), &mut index), 0);
        assert_eq!(index, 1);
        let mut buf = [1 as c_char; 32];
        assert_eq!(EN_getnodeid(ph, 2, buf.as_mut_ptr()), 0);
        assert_eq!(cstr(&buf), "R");
        // Output pointers may be null.
        assert_eq!(EN_getnodevalue(ph, 1, 0, ptr::null_mut()), 0);

        assert_eq!(EN_solveH(ph), 0);
        let mut heads: [c_double; 2] = [0.0; 2];
        assert_eq!(EN_getnodevalues(ph, 10, heads.as_mut_ptr()), 0);
        assert!(
            heads[0] > 100.0 && heads[0] < 200.0 && heads[1] == 200.0,
            "{heads:?}"
        );
        let mut t: c_long = -1;
        assert_eq!(EN_gettimeparam(ph, 0, &mut t), 0);
        assert_eq!(t, 7200);

        let mut msg = [0 as c_char; 256];
        assert_eq!(EN_geterror(204, msg.as_mut_ptr(), 255), 0);
        assert_eq!(
            cstr(&msg),
            "Error 204: function call contains undefined link"
        );
        assert_eq!(EN_geterror(204, msg.as_mut_ptr(), 5), 0);
        assert_eq!(cstr(&msg), "Erro");

        assert_eq!(EN_close(ph), 0);
        assert_eq!(EN_getcount(ph, 0, &mut n), 102);
        assert_eq!(EN_deleteproject(ph), 0);
    }
    std::fs::remove_dir_all(&dir).ok();
}
