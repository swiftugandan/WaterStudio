// SPDX-License-Identifier: MIT
// Derived from OWA-EPANET 2.3.5 (epanet.c and openhydfile in project.c),
// Copyright (c) 2019 OWA-EPANET authors. See LICENSES/OWA-EPANET.txt.

//! External hydraulics files: `EN_savehydfile` and `EN_usehydfile`.

use super::Toolkit;
use crate::quality;

impl Toolkit {
    /// `EN_savehydfile`: the hydraulics file of the last saved hydraulic run (or the
    /// file in use), copied to `filename`.
    pub fn savehydfile(&self, filename: &str) -> i32 {
        let Some(o) = self.o() else { return 104 };
        if !o.save_h {
            return 104;
        }
        let bytes = match &o.hyd_raw {
            Some(raw) => raw.clone(),
            None => quality::hydfile_bytes(&o.hyd_sizes, &o.hydfile),
        };
        if std::fs::write(filename, bytes).is_err() {
            return 305;
        }
        0
    }

    /// `EN_usehydfile`: take the hydraulics for water quality analyses from a file
    /// `EN_savehydfile` wrote for this network. From then on the hydraulic solver
    /// refuses to open (107).
    pub fn usehydfile(&mut self, filename: &str) -> i32 {
        let Some(o) = self.p.as_deref_mut() else {
            return 102;
        };
        if o.open_h {
            return 108;
        }
        // openhydfile closes the current file before it opens this one.
        o.hydfile.clear();
        o.hyd_next = 0;
        o.hyd_raw = None;
        let read = std::fs::read(filename)
            .map_err(|_| 305)
            .and_then(|bytes| quality::read_hydfile(&o.pr, &bytes).map(|r| (r, bytes)));
        match read {
            Ok((records, bytes)) => {
                o.hydfile = records;
                o.hyd_raw = Some(bytes);
                o.hyd_use = true;
                o.hyd_fname = filename.to_string();
                super::truncate_bytes(&mut o.hyd_fname, MAXFNAME);
                o.save_h = true;
                0
            }
            Err(code) => {
                o.hyd_use = false;
                o.hyd_fname.clear();
                o.save_h = false;
                code
            }
        }
    }
}

/// `MAXFNAME` (types.h).
const MAXFNAME: usize = 259;
