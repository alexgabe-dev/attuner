use attuner_sync_core::*;
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    sync::{Arc, Mutex},
    time::Instant,
};
fn main() -> Result<()> {
    let checkpoints = Arc::new(Mutex::new(BTreeMap::<String, u64>::new()));
    let observed = checkpoints.clone();
    let durations = Arc::new(Mutex::new(BTreeMap::<String, u64>::new()));
    let observed_durations = durations.clone();
    let control = Control::fixture().with_observer(move |event| {
        *observed
            .lock()
            .unwrap()
            .entry(format!("{:?}", event.point))
            .or_default() += 1;
        if let Some(micros) = event.elapsed_micros {
            *observed_durations
                .lock()
                .unwrap()
                .entry(format!("{:?}", event.point))
                .or_default() += micros;
        }
        Ok(())
    });
    let mut engine = Engine::create_fixture(1, &control)?;
    let path = engine.path().to_owned();
    let result = (|| -> Result<serde_json::Value> {
        let directory = path.join("installation/ProfileData/Synthetic");
        fs::create_dir(&directory)?;
        for index in 0..10_000_u32 {
            let mut data = [b'x'; 4096];
            data[..4].copy_from_slice(&index.to_le_bytes());
            fs::write(directory.join(format!("config-{index:05}.bin")), data)?;
        }
        let mut large = fs::File::create(directory.join("large.bin"))?;
        let block = [b'Z'; 65536];
        for _ in 0..2048 {
            large.write_all(&block)?;
        }
        large.sync_all()?;
        drop(large);
        let start = Instant::now();
        let scan = engine.scan(&control)?;
        let scan_ms = start.elapsed().as_secs_f64() * 1000.;
        checkpoints.lock().unwrap().clear();
        durations.lock().unwrap().clear();
        let start = Instant::now();
        let initial = engine.capture_snapshot(&scan, "Large synthetic baseline", &control)?;
        let snapshot_ms = start.elapsed().as_secs_f64() * 1000.;
        let first_counts = checkpoints.lock().unwrap().clone();
        let first_durations = durations.lock().unwrap().clone();
        durations.lock().unwrap().clear();
        checkpoints.lock().unwrap().clear();
        let start = Instant::now();
        engine.capture_snapshot(&scan, "Unchanged synthetic checkpoint", &control)?;
        let unchanged_ms = start.elapsed().as_secs_f64() * 1000.;
        let unchanged_counts = checkpoints.lock().unwrap().clone();
        let unchanged_durations = durations.lock().unwrap().clone();
        checkpoints.lock().unwrap().clear();
        durations.lock().unwrap().clear();
        assert_eq!(unchanged_counts.get("BackupChunk").copied().unwrap_or(0), 0);
        assert_eq!(
            unchanged_counts.get("BackupVerified").copied().unwrap_or(0),
            0
        );
        let start = Instant::now();
        engine.verify_snapshot(initial.id, &control)?;
        let verify_ms = start.elapsed().as_secs_f64() * 1000.;
        let small = directory.join("config-00000.bin");
        let old = fs::read(&small)?;
        fs::write(&small, b"changed synthetic configuration\r\n")?;
        let modified = engine.scan(&control)?;
        let changed_start = Instant::now();
        let target = engine.capture_snapshot(&modified, "Synthetic variation", &control)?;
        let changed_ms = changed_start.elapsed().as_secs_f64() * 1000.;
        let changed_counts = checkpoints.lock().unwrap().clone();
        fs::write(&small, old)?;
        let expected = engine.scan(&control)?;
        let start = Instant::now();
        engine.apply_snapshot(target.id, &expected, &control)?;
        let apply_ms = start.elapsed().as_secs_f64() * 1000.;
        Ok(
            serde_json::json!({"files":scan.files,"bytes":scan.bytes,"scanMs":scan_ms,"snapshotMs":snapshot_ms,"verifyMs":verify_ms,"applyOneChangeMs":apply_ms,"scanLogicalMiBPerSecond":(scan.bytes as f64/1048576.)/(scan_ms/1000.),"hashReadBufferBytes":65536,"scanHashPasses":2,"sqlite":engine.sqlite_version(),"scope":"isolated synthetic directory; warm OS cache; first capture cold CAS, unchanged capture warm CAS", "unchangedCaptureMs":unchanged_ms, "firstCaptureTimingsMicros":first_durations,"unchangedCaptureTimingsMicros":unchanged_durations,"changedCaptureMs":changed_ms,"changedCaptureCheckpoints":changed_counts,"firstCaptureCheckpoints":first_counts, "unchangedCaptureCheckpoints":unchanged_counts}),
        )
    })();
    drop(engine);
    fs::remove_dir_all(path)?;
    println!("{}", serde_json::to_string_pretty(&result?)?);
    Ok(())
}
