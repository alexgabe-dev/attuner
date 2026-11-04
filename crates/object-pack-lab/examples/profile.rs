#[cfg(unix)]
fn main() -> attuner_object_pack_lab::Result<()> {
    use attuner_object_pack_lab::{Capture, Control, Format, Lab};
    use std::time::Instant;
    let control = Control::default();
    let mut results = Vec::new();
    for (name, files, small, large, entropy) in [
        (
            "many-small-and-large-compressible",
            10000,
            4096,
            128 * 1024 * 1024,
            false,
        ),
        (
            "many-small-and-large-high-entropy",
            10000,
            4096,
            128 * 1024 * 1024,
            true,
        ),
        (
            "large-only-compressible",
            3,
            32 * 1024 * 1024,
            32 * 1024 * 1024,
            false,
        ),
        (
            "large-only-high-entropy",
            3,
            32 * 1024 * 1024,
            32 * 1024 * 1024,
            true,
        ),
    ] {
        for format in [Format::Legacy, Format::Pack] {
            eprintln!("Synthetic profile: {name}, {format:?}");
            let mut lab = Lab::new()?;
            lab.generate(files, small, large, entropy)?;
            let mut measurements = Vec::new();
            let mut measure = |phase: &str,
                               lab: &mut Lab|
             -> attuner_object_pack_lab::Result<Capture> {
                let start = Instant::now();
                let capture = lab.capture(format, &control)?;
                let milliseconds = start.elapsed().as_secs_f64() * 1000.;
                let verify_start = Instant::now();
                assert_eq!(lab.verify(capture.snapshot, &control)?, capture.files);
                measurements.push(serde_json::json!({"phase":phase,"milliseconds":milliseconds,"verifyMilliseconds":verify_start.elapsed().as_secs_f64()*1000.,"capture":capture}));
                Ok(capture)
            };
            measure("first-cold-cas", &mut lab)?;
            let unchanged = measure("unchanged-warm-cas", &mut lab)?;
            assert_eq!((unchanged.new_objects, unchanged.file_flushes), (0, 0));
            lab.change(0, small, entropy, 1)?;
            assert_eq!(measure("one-change", &mut lab)?.new_objects, 1);
            let changed = files.div_ceil(100);
            for index in 0..changed {
                lab.change(index, small, entropy, 2)?;
            }
            assert_eq!(
                measure("one-percent-change", &mut lab)?.new_objects,
                changed
            );
            results.push(serde_json::json!({"workload":name,"format":format!("{format:?}"),"entropy":"deterministic synthetic PRNG; not cryptographic randomness","measurements":measurements}));
        }
    }
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    // SAFETY: correctly sized output, initialized only after successful syscall.
    let peak_rss = if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } == 0 {
        let raw = unsafe { usage.assume_init() }.ru_maxrss as u64;
        Some(if cfg!(target_os = "macos") {
            raw
        } else {
            raw * 1024
        })
    } else {
        None
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "schemaVersion":1,"experiment":"isolated object packs; production format unchanged",
            "os":std::env::consts::OS,"architecture":std::env::consts::ARCH,
            "scope":"synthetic temporary roots; warm OS cache after generation; cold CAS and warm CAS are distinct; no OS cache purge or hardware reset",
            "durability":"file sync_all, no-clobber promotion, directory sync_all before SQLite FULL commit; process interruption tested, hardware power loss unqualified",
            "hashBufferBytes":65536,"decoderWindowLimitBytes":8388608,"maxIndexBytes":524288,"maxPackFrames":2048,
            "peakProcessRssBytes":peak_rss,"results":results
        }))?
    );
    Ok(())
}
#[cfg(not(unix))]
fn main() {
    eprintln!("Unix-only isolated experiment; no Windows qualification.");
    std::process::exit(2);
}
