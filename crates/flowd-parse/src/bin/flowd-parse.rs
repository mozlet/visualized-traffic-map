use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Write};

use anyhow::Context;
use flowd_parse::FlowIter;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let reader: Box<dyn Read> = match args.get(1).map(String::as_str) {
        None | Some("-") => Box::new(io::stdin().lock()),
        Some(path) => {
            let f = File::open(path).with_context(|| format!("open {path}"))?;
            Box::new(f)
        }
    };
    let mut reader = BufReader::new(reader);
    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());

    let mut count: u64 = 0;
    let mut errors: u64 = 0;
    for item in FlowIter::new(&mut reader) {
        match item {
            Ok(rec) => {
                if let Err(e) = write_record(&mut out, &rec) {
                    if e.kind() == io::ErrorKind::BrokenPipe {
                        // Downstream closed (e.g. `| head`). Exit quietly.
                        return Ok(());
                    }
                    return Err(e.into());
                }
                count += 1;
            }
            Err(e) => {
                errors += 1;
                eprintln!("flowd-parse: {e}");
                break;
            }
        }
    }
    if let Err(e) = out.flush() {
        if e.kind() == io::ErrorKind::BrokenPipe {
            return Ok(());
        }
        return Err(e.into());
    }
    eprintln!("flowd-parse: {count} records, {errors} errors");
    if errors > 0 {
        std::process::exit(1);
    }
    Ok(())
}

fn write_record<W: Write>(out: &mut W, rec: &flowd_parse::FlowRecord) -> io::Result<()> {
    serde_json::to_writer(&mut *out, rec).map_err(io::Error::from)?;
    out.write_all(b"\n")
}
