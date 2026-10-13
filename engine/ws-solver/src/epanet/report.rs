// SPDX-License-Identifier: MIT
// Derived from OWA-EPANET 2.3.5 (epanet.c, report.c, project.c, output.c), Copyright
// (c) 2019 OWA-EPANET authors. See LICENSES/OWA-EPANET.txt.

//! The toolkit's report and binary output files: `EN_open` with report and output file
//! names, `EN_report`, `EN_saveH` and the report options and utilities.
//!
//! The report is built by the same module the whole-run path uses, as the calls go,
//! and handed to the caller to write (`flush_report`): to its file, to standard output
//! when no name was given, or line by line to a callback. The output file is written
//! when a quality run that saves results ends.

use super::*;
use crate::output::{self, Columns};
use crate::report::{self, ReportFile};

/// Where the report goes.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) enum ReportTarget {
    /// No report (a project opened without files, from a model or text).
    #[default]
    None,
    /// `EN_open` with an empty report name: standard output.
    Stdout,
    File(String),
}

/// The output file being saved by a quality run (`openoutfile`, `saveoutput`).
#[derive(Clone, Debug, Default)]
pub(crate) struct Output {
    pub(super) prolog: Vec<u8>,
    pub(super) energy: Vec<u8>,
    pub(super) cols: Columns,
    /// Whether `cols` already holds the time statistic rather than every period.
    pub(super) reduced: bool,
}

/// `FlowUnitsTxt`, by `EN_FlowUnits` code.
const FLOW_UNITS_WORDS: [&str; 11] = [
    "CFS", "GPM", "MGD", "IMGD", "AFD", "LPS", "LPM", "MLD", "CMH", "CMD", "CMS",
];

/// `openfiles`: the file names must differ (301).
fn check_files(inp_file: &str, rpt_file: &str, out_file: &str) -> Result<(), i32> {
    let same = |a: &str, b: &str| a.eq_ignore_ascii_case(b);
    if !inp_file.is_empty() && (same(inp_file, rpt_file) || same(inp_file, out_file)) {
        return Err(301);
    }
    if !out_file.is_empty() && same(rpt_file, out_file) {
        return Err(301);
    }
    Ok(())
}

/// `openfiles`: the report file, emptied (303 if it cannot be written), or standard
/// output for an empty name.
fn open_report(rpt_file: &str) -> Result<ReportTarget, i32> {
    if rpt_file.is_empty() {
        return Ok(ReportTarget::Stdout);
    }
    if std::fs::write(rpt_file, "").is_err() {
        return Err(303);
    }
    Ok(ReportTarget::File(rpt_file.to_string()))
}

/// The report EPANET writes for a file it refuses to open (`openproject` failing, in
/// `EN_open` or a whole run): the logo, every input error, and the error `code` unless
/// the file says [REPORT] MESSAGES NO. `date` is the clock time in C's `ctime` form.
pub fn refused_report(check: &ws_io::Check, date: &str, code: i32) -> String {
    let mut pr = Project::default();
    pr.rpt.file = Some(ReportFile::default());
    pr.rpt.date = date.to_string();
    write_logo_and_errors(&mut pr, check);
    pr.rpt.page_size = check.page_size;
    pr.rpt.title0.clone_from(&check.title);
    if check.messages {
        let s = format!("Error {code}: {}", errmsg_text(code));
        report::writeline(&mut pr, &s);
    }
    pr.rpt.file.take().map(|f| f.text).unwrap_or_default()
}

/// The report as EPANET writes it while opening a file: the logo (`openfiles`, before
/// any data is read, so with no page breaks or title), then `inperrmsg` (and
/// `ruleerrmsg`) for each input error with the page size and title read before it.
fn write_logo_and_errors(pr: &mut Project, check: &ws_io::Check) {
    let (page_size, title0) = (pr.rpt.page_size, pr.rpt.title0.clone());
    pr.rpt.page_size = 0;
    pr.rpt.title0.clear();
    report::writelogo(pr);
    for e in &check.errors {
        pr.rpt.page_size = e.page_size;
        pr.rpt.title0.clone_from(&e.title);
        for line in e.report_lines() {
            report::writeline(pr, &line);
        }
    }
    pr.rpt.page_size = page_size;
    pr.rpt.title0 = title0;
}

/// Report text the caller must deliver.
#[derive(Clone, Debug, PartialEq)]
pub enum ReportOutput {
    Nothing,
    /// To standard output.
    Stdout(String),
    /// To the report callback, one line at a time.
    Lines(Vec<String>),
}

impl Open {
    /// `errmsg`: an error's line in the report.
    pub(super) fn errmsg(&mut self, code: i32) {
        if code > 100 && code != 309 && self.pr.rpt.messageflag && report::writing(&self.pr) {
            let s = format!("Error {code}: {}", errmsg_text(code));
            report::writeline(&mut self.pr, &s);
        }
    }
}

impl Toolkit {
    /// `EN_open` with its report and output file names. `date` is the clock time in
    /// C's `ctime` form for the report's header. An empty report name sends the report
    /// to standard output; an empty output name keeps the results in memory only.
    pub fn open_files(
        &mut self,
        inp_file: &str,
        rpt_file: &str,
        out_file: &str,
        date: &str,
    ) -> i32 {
        self.openproject(inp_file, rpt_file, out_file, date, false)
    }

    /// `EN_openX`: as [`Self::open_files`], but a file with input errors still opens,
    /// with the network EPANET read from it, and returns 200.
    pub fn open_files_x(
        &mut self,
        inp_file: &str,
        rpt_file: &str,
        out_file: &str,
        date: &str,
    ) -> i32 {
        self.openproject(inp_file, rpt_file, out_file, date, true)
    }

    /// `openproject`
    fn openproject(
        &mut self,
        inp_file: &str,
        rpt_file: &str,
        out_file: &str,
        date: &str,
        allow_errors: bool,
    ) -> i32 {
        self.close();
        // openfiles: the input file is opened before the report, so without one there
        // is no report either.
        if let Err(e) = check_files(inp_file, rpt_file, out_file) {
            return e;
        }
        let Ok(bytes) = std::fs::read(inp_file) else {
            return 302;
        };
        let target = match open_report(rpt_file) {
            Ok(t) => t,
            Err(e) => return e,
        };
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let (check, model) = ws_io::read_as_epanet(&text);
        let code = i32::from(check.code());
        if !(code == 0 || (allow_errors && code == 200)) {
            self.failed_open_report(&target, date, &check, code);
            return code;
        }
        let title = model.title.clone();
        let built = self.open_model(model);
        if built != 0 {
            self.failed_open_report(&target, date, &check, built);
            return built;
        }
        if let Some(o) = self.p.as_deref_mut() {
            o.inp_name = inp_file.to_string();
            o.rpt1 = rpt_file.to_string();
            o.out_path = out_file.to_string();
            o.target = target;
            let pr = &mut o.pr;
            pr.rpt.file = Some(ReportFile::default());
            pr.rpt.date = date.to_string();
            write_logo_and_errors(pr, &check);
            if pr.rpt.summaryflag {
                report::writesummary(pr, &title, inp_file);
            }
            o.errmsg(code);
        }
        code
    }

    /// `EN_init`: an empty project with the given flow units and head loss formula,
    /// reporting to `rpt_file` (standard output if empty).
    pub fn init(
        &mut self,
        rpt_file: &str,
        out_file: &str,
        units_type: i32,
        head_loss_type: i32,
        date: &str,
    ) -> i32 {
        self.close();
        let Some(units) = usize::try_from(units_type)
            .ok()
            .and_then(|u| FLOW_UNITS_WORDS.get(u))
        else {
            return 251;
        };
        let Some(formula) = usize::try_from(head_loss_type)
            .ok()
            .and_then(|h| ["H-W", "D-W", "C-M"].get(h))
        else {
            return 251;
        };
        let target = match check_files("", rpt_file, out_file).and_then(|()| open_report(rpt_file))
        {
            Ok(t) => t,
            Err(e) => return e,
        };
        let code = self.open_text(&format!(
            "[OPTIONS]\n UNITS {units}\n HEADLOSS {formula}\n[END]\n"
        ));
        if code != 0 {
            return code;
        }
        if let Some(o) = self.p.as_deref_mut() {
            o.rpt1 = rpt_file.to_string();
            o.out_path = out_file.to_string();
            o.target = target;
            let pr = &mut o.pr;
            // EN_init calls initreport after adjustdata, so quality stays a reported
            // variable even without a quality analysis.
            pr.rpt.field[crate::types::Field::Quality as usize].enabled = true;
            pr.rpt.file = Some(ReportFile::default());
            pr.rpt.date = date.to_string();
            report::writelogo(pr);
        }
        0
    }

    /// The report of an `EN_open` that failed.
    fn failed_open_report(
        &mut self,
        target: &ReportTarget,
        date: &str,
        check: &ws_io::Check,
        code: i32,
    ) {
        let text = refused_report(check, date, code);
        self.pending_failed = Some((target.clone(), text));
    }

    /// `EN_runproject`: open a file, solve its hydraulics and water quality, write the
    /// report and close, as `runepanet` does. A file that will not open or a network
    /// that will not solve leaves the report EPANET writes up to the failure. Returns
    /// the error or warning code, and report text still to deliver (to standard output
    /// when no report name was given).
    pub fn run_project(
        &mut self,
        inp_file: &str,
        rpt_file: &str,
        out_file: &str,
        date: &str,
    ) -> (i32, ReportOutput) {
        // ERRCODE: a later step runs only while there is no error (a warning is not one).
        let mut errcode = self.open_files(inp_file, rpt_file, out_file, date);
        for step in [Self::solve_h, Self::solve_q, Self::report] {
            if errcode <= 100 {
                errcode = step(self);
            }
        }
        let warn = self.o().map_or(0, |o| o.pr.warnflag);
        let pending = self.flush_report();
        self.close();
        (errcode.max(warn), pending)
    }

    /// Report text written since the last call, for the caller to deliver; a report
    /// file is appended to here.
    pub fn flush_report(&mut self) -> ReportOutput {
        if let Some((target, text)) = self.pending_failed.take() {
            return deliver(&target, text);
        }
        let Some(o) = self.p.as_deref_mut() else {
            return ReportOutput::Nothing;
        };
        let Some(f) = &mut o.pr.rpt.file else {
            return ReportOutput::Nothing;
        };
        if let Some(lines) = &mut f.callback_lines {
            return if lines.is_empty() {
                ReportOutput::Nothing
            } else {
                ReportOutput::Lines(std::mem::take(lines))
            };
        }
        if f.text.is_empty() {
            return ReportOutput::Nothing;
        }
        let text = std::mem::take(&mut f.text);
        deliver(&o.target, text)
    }

    /// Send report lines to a callback (`EN_setreportcallback`) instead of the file.
    pub fn set_report_callback(&mut self, on: bool) {
        if let Some(o) = self.p.as_deref_mut() {
            let f = o.pr.rpt.file.get_or_insert_with(ReportFile::default);
            if on {
                f.callback_lines.get_or_insert_with(Vec::new);
            } else {
                f.callback_lines = None;
            }
        }
    }

    /// `EN_writeline`
    pub fn writeline(&mut self, line: &str) -> i32 {
        let Some(o) = self.om() else { return 102 };
        report::writeline(&mut o.pr, line);
        0
    }

    /// `EN_setreport`: one [REPORT] line.
    pub fn setreport(&mut self, format: &str) -> i32 {
        let Some(o) = self.om() else { return 102 };
        if format.len() >= 1024 {
            return 250;
        }
        let tok = ws_io::tokenize(format).tokens;
        if tok.is_empty() {
            return 0;
        }
        let net = &o.pr.net;
        let nodes: std::collections::HashMap<&str, usize> = (1..=net.nnodes)
            .map(|i| (net.node[i].id.as_str(), i))
            .collect();
        let links: std::collections::HashMap<&str, usize> = (1..=net.nlinks)
            .map(|i| (net.link[i].id.as_str(), i))
            .collect();
        let mut rpt = std::mem::take(&mut o.pr.rpt);
        let r = report::reportline(&mut rpt, &tok, &|id| nodes.get(id).copied(), &|id| {
            links.get(id).copied()
        });
        o.pr.rpt = rpt;
        if r.is_err() { 250 } else { 0 }
    }

    /// `EN_resetreport`
    pub fn resetreport(&mut self) -> i32 {
        let Some(o) = self.om() else { return 102 };
        let (nn, nl) = (o.pr.net.nnodes, o.pr.net.nlinks);
        report::resetreport(&mut o.pr.rpt, nn, nl);
        0
    }

    /// `EN_setstatusreport`
    pub fn setstatusreport(&mut self, level: i32) -> i32 {
        let flag = match level {
            0 => report::Statflag::No,
            1 => report::Statflag::Yes,
            2 => report::Statflag::Full,
            _ => return 251,
        };
        if let Some(o) = self.om() {
            o.pr.rpt.statflag = flag;
        }
        0
    }

    /// `EN_clearreport`: empty the report file and start it again with the logo.
    pub fn clearreport(&mut self) -> i32 {
        let Some(o) = self.om() else { return 0 };
        let ReportTarget::File(path) = o.target.clone() else {
            return 0;
        };
        if o.pr.rpt.file.is_none() {
            return 0;
        }
        if std::fs::write(&path, "").is_err() {
            return 303;
        }
        if let Some(f) = &mut o.pr.rpt.file {
            f.text.clear();
        }
        report::writelogo(&mut o.pr);
        0
    }

    /// `EN_copyreport`: copy the report file (as written so far) to another file.
    pub fn copyreport(&mut self, filename: &str) -> i32 {
        let pending = self.flush_report();
        let Some(o) = self.o() else { return 0 };
        let ReportTarget::File(path) = &o.target else {
            return 0;
        };
        debug_assert!(pending == ReportOutput::Nothing);
        let content = std::fs::read(path).unwrap_or_default();
        if std::fs::write(filename, content).is_err() {
            return 303;
        }
        0
    }

    /// `EN_report`: the energy and results tables of the saved run.
    pub fn report(&mut self) -> i32 {
        let Some(o) = self.om() else { return 106 };
        if !o.save_q {
            return 106;
        }
        let Some(out) = &o.output else { return 106 };
        let (cols, periods) = if out.reduced {
            (out.cols.clone(), o.nperiods as usize)
        } else {
            let (c, n) = output::file_columns(&o.pr, &out.cols, o.nperiods as usize);
            (c.into_owned(), n)
        };
        let rpt2 = o.pr.rpt.rpt2_fname.clone();
        let same = |a: &str, b: &str| a.eq_ignore_ascii_case(b);
        if rpt2.is_empty() || same(&rpt2, &o.inp_name) || same(&rpt2, &o.rpt1) {
            if o.target != ReportTarget::None {
                if o.pr.rpt.energyflag {
                    report::writeenergy(&mut o.pr);
                }
                report::writeresults(&mut o.pr, &cols, periods);
            }
            return 0;
        }
        // A secondary report file gets a full report of its own.
        let main = o.pr.rpt.file.replace(ReportFile::default());
        let title = o.meta.title.to_vec();
        let inp = o.inp_name.clone();
        report::writelogo(&mut o.pr);
        if o.pr.rpt.summaryflag {
            report::writesummary(&mut o.pr, &title, &inp);
        }
        if o.pr.rpt.energyflag {
            report::writeenergy(&mut o.pr);
        }
        report::writeresults(&mut o.pr, &cols, periods);
        let text = o.pr.rpt.file.take().map(|f| f.text).unwrap_or_default();
        o.pr.rpt.file = main;
        if std::fs::write(&rpt2, text).is_err() {
            return 303;
        }
        0
    }

    /// `EN_saveH`: transfer the saved hydraulics to the output file without a quality
    /// analysis.
    pub fn save_h(&mut self) -> i32 {
        let Some(o) = self.om() else { return 104 };
        if !o.save_h {
            return 104;
        }
        let saved = o.pr.qual.qualflag;
        o.pr.qual.qualflag = QualType::None;
        let e = self.solve_q();
        if let Some(o) = self.om() {
            o.pr.qual.qualflag = saved;
            o.errmsg(e);
        }
        e
    }

    /// `openoutfile` (from `EN_initQ` with `EN_SAVE`): the prolog and pump energy.
    pub(super) fn open_output(o: &mut Open) {
        let title = o.meta.title.to_vec();
        let prolog = output::savenetdata(&o.pr, &title, &o.inp_name);
        let energy = output::saveenergy(&mut o.pr);
        o.output = Some(Output {
            prolog,
            energy,
            cols: Columns::default(),
            reduced: false,
        });
    }

    /// `saveoutput`: the current solution as one period of the output file.
    pub(super) fn save_output(o: &mut Open) {
        if let Some(out) = &mut o.output {
            output::save_hydraulics(&o.pr, &mut out.cols);
            output::save_quality(&o.pr, &mut out.cols);
        }
    }

    /// `savefinaloutput`: with a time statistic the saved periods become the one
    /// statistic (`savetimestat`, which also leaves it in the node demands, heads and
    /// qualities and the link flows); then the file is written if it has a name.
    pub(super) fn finish_output(o: &mut Open) -> i32 {
        let Some(out) = &mut o.output else { return 0 };
        if o.pr.rpt.tstatflag != crate::report::Tstat::Series {
            let (nn, nl) = (o.pr.net.nnodes, o.pr.net.nlinks);
            let stat = output::timestat(&out.cols, o.pr.rpt.tstatflag, nn, nl, o.nperiods as usize);
            let ucf = o.pr.units.ucf;
            let at = |v: &Vec<f32>, i: usize| f64::from(v.get(i - 1).copied().unwrap_or(0.0));
            for i in 1..=nn {
                o.pr.hyd.node_demand[i] = at(&stat.nodes[0], i) / ucf[Field::Demand as usize];
                o.pr.hyd.node_head[i] = at(&stat.nodes[1], i) / ucf[Field::Head as usize];
                o.pr.qual.node_qual[i] = at(&stat.nodes[3], i) / ucf[Field::Quality as usize];
            }
            for k in 1..=nl {
                o.pr.hyd.link_flow[k] = at(&stat.links[0], k) / ucf[Field::Flow as usize];
            }
            out.cols = stat;
            out.reduced = true;
            o.nperiods = 1;
        }
        if o.out_path.is_empty() {
            return 0;
        }
        let bytes = output::outfile_bytes(
            &o.pr,
            &out.prolog,
            &out.energy,
            &out.cols,
            o.nperiods as usize,
            out.reduced,
        );
        if std::fs::write(&o.out_path, bytes).is_err() {
            return 308;
        }
        0
    }
}

fn deliver(target: &ReportTarget, text: String) -> ReportOutput {
    match target {
        ReportTarget::None => ReportOutput::Nothing,
        ReportTarget::Stdout => ReportOutput::Stdout(text),
        ReportTarget::File(path) => {
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .append(true)
                .create(true)
                .open(path)
            {
                let _ = f.write_all(text.as_bytes());
            }
            ReportOutput::Nothing
        }
    }
}
