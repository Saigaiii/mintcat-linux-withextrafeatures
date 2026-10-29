use anyhow::Context;
use mintcat_integrator_api::{ConflictCheckModInfo, ModConflict};
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// Where a mod's file can be read from (to fingerprint it when it conflicts)
#[derive(Debug, Clone)]
enum FileSource {
    Pak { pak: PathBuf, entry: String },
    Disk(PathBuf),
}

type ModFiles = Vec<(String, FileSource)>;

fn normalize_pak_entry(mount_point: &str, entry: &str) -> String {
    // Paths in the index are relative to the mount point ("../../../" or
    // "../../../FSD/" etc.), so join them with a separator before comparing.
    let mount = mount_point.trim_end_matches('/');
    let file = entry.trim_start_matches('/');
    let full_path = if mount.is_empty() {
        file.to_string()
    } else {
        format!("{}/{}", mount, file)
    };
    let mut rel = full_path.as_str();
    while let Some(rest) = rel.strip_prefix("../") {
        rel = rest;
    }
    rel.trim_start_matches('/').to_lowercase()
}

fn open_pak(pak_path: &Path) -> anyhow::Result<(repak::PakReader, BufReader<fs::File>)> {
    let file = fs::File::open(pak_path)
        .with_context(|| format!("Failed to open pak file: {}", pak_path.display()))?;
    let mut reader = BufReader::new(file);
    let pak = repak::PakBuilder::new()
        .reader(&mut reader)
        .with_context(|| format!("Failed to parse pak file: {}", pak_path.display()))?;
    Ok((pak, reader))
}

fn get_pak_files(pak_path: &str) -> anyhow::Result<ModFiles> {
    let path = PathBuf::from(pak_path);
    let (pak, _reader) = open_pak(&path)?;
    let mount_point = pak.mount_point().to_string();
    Ok(pak
        .files()
        .iter()
        .map(|entry| {
            (
                normalize_pak_entry(&mount_point, entry),
                FileSource::Pak { pak: path.clone(), entry: entry.to_string() },
            )
        })
        .collect())
}

fn content_prefix_for_game(game_name: Option<&str>) -> &'static str {
    match game_name {
        Some(name) if name.eq_ignore_ascii_case("rc") => "roguecore",
        _ => "fsd",
    }
}

fn get_unpacked_mod_files(dir_path: &str, content_prefix: &str) -> anyhow::Result<ModFiles> {
    let path = Path::new(dir_path);
    let content_path = path.join("Content");

    if !content_path.is_dir() {
        anyhow::bail!("Content directory not found in unpacked mod: {}", dir_path);
    }

    let mut files = Vec::new();

    for entry in WalkDir::new(&content_path)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let entry_path = entry.path();
        if entry_path.is_dir() {
            continue;
        }

        if let Ok(relative) = entry_path.strip_prefix(&content_path) {
            let pak_path = format!(
                "{}/content/{}",
                content_prefix.to_lowercase(),
                relative.to_string_lossy().replace('\\', "/").to_lowercase()
            );
            files.push((pak_path, FileSource::Disk(entry_path.to_path_buf())));
        }
    }

    Ok(files)
}

fn get_directory_mod_pak_files(dir_path: &str, content_prefix: &str) -> anyhow::Result<ModFiles> {
    let path = Path::new(dir_path);
    let mut all_files = Vec::new();

    let content_path = path.join("Content");
    if content_path.is_dir() {
        if let Ok(files) = get_unpacked_mod_files(dir_path, content_prefix) {
            all_files.extend(files);
        }
    }

    let pak_dir = path.join("pak");
    if pak_dir.is_dir() {
        if let Ok(entries) = fs::read_dir(&pak_dir) {
            for entry in entries.flatten() {
                let entry_path = entry.path();
                if entry_path.is_file()
                    && entry_path
                        .extension()
                        .and_then(|e| e.to_str())
                        .map_or(false, |e| e.eq_ignore_ascii_case("pak"))
                {
                    if let Some(p) = entry_path.to_str() {
                        if let Ok(files) = get_pak_files(p) {
                            all_files.extend(files);
                        }
                    }
                }
            }
        }
    }

    Ok(all_files)
}

fn fingerprint(data: &[u8]) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    data.hash(&mut hasher);
    format!("{:016x}-{}", hasher.finish(), data.len())
}

/// Fingerprint the given (conflicting) files of one mod, opening each pak once.
fn fingerprint_files(files: &[(&String, &FileSource)]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut by_pak: HashMap<&PathBuf, Vec<(&String, &String)>> = HashMap::new();

    for (path, source) in files {
        match source {
            FileSource::Disk(disk) => {
                if let Ok(data) = fs::read(disk) {
                    out.insert((*path).clone(), fingerprint(&data));
                }
            }
            FileSource::Pak { pak, entry } => by_pak.entry(pak).or_default().push((path, entry)),
        }
    }

    for (pak_path, entries) in by_pak {
        let Ok((pak, mut reader)) = open_pak(pak_path) else { continue };
        for (path, entry) in entries {
            if let Ok(data) = pak.get(entry, &mut reader) {
                out.insert(path.clone(), fingerprint(&data));
            }
        }
    }
    out
}

pub fn check_mod_conflicts_from_json(
    mod_list_json: &str,
    game_name: Option<&str>,
) -> Result<Vec<ModConflict>, String> {
    let mods: Vec<ConflictCheckModInfo> = serde_json::from_str(mod_list_json)
        .map_err(|_| "backend.error.parse_mod_list".to_string())?;

    Ok(check_mod_conflicts(&mods, game_name))
}

pub fn check_mod_conflicts(
    mods: &[ConflictCheckModInfo],
    game_name: Option<&str>,
) -> Vec<ModConflict> {
    let content_prefix = content_prefix_for_game(game_name);
    let mut file_to_mods: HashMap<String, Vec<i64>> = HashMap::new();
    // mod id -> (normalized path -> where to read it)
    let mut sources: HashMap<i64, HashMap<String, FileSource>> = HashMap::new();

    for mod_info in mods {
        let files = if mod_info.is_unpacked {
            get_directory_mod_pak_files(&mod_info.cache_path, content_prefix)
        } else {
            get_pak_files(&mod_info.cache_path)
        };

        match files {
            Ok(file_list) => {
                let mod_sources = sources.entry(mod_info.mod_id).or_default();
                for (file_path, source) in file_list {
                    // The installer never writes these from mods (see pak_integrator),
                    // so they can't conflict in practice.
                    if file_path.ends_with("assetregistry.bin")
                        || file_path.ends_with(".ushaderbytecode")
                    {
                        continue;
                    }
                    let ids = file_to_mods.entry(file_path.clone()).or_default();
                    // A mod with several paks can list a path twice; that's not a conflict
                    if !ids.contains(&mod_info.mod_id) {
                        ids.push(mod_info.mod_id);
                        mod_sources.insert(file_path, source);
                    }
                }
            }
            Err(error) => {
                eprintln!("Failed to read mod {}: {:#}", mod_info.mod_id, error);
            }
        }
    }

    let mut mod_conflicts: HashMap<i64, (Vec<i64>, Vec<String>)> = HashMap::new();

    for (file_path, mod_ids) in file_to_mods {
        if mod_ids.len() > 1 {
            for &mod_id in &mod_ids {
                let entry = mod_conflicts
                    .entry(mod_id)
                    .or_insert_with(|| (Vec::new(), Vec::new()));

                for &other_mod_id in &mod_ids {
                    if other_mod_id != mod_id && !entry.0.contains(&other_mod_id) {
                        entry.0.push(other_mod_id);
                    }
                }

                if !entry.1.contains(&file_path) {
                    entry.1.push(file_path.clone());
                }
            }
        }
    }

    mod_conflicts
        .into_iter()
        .map(|(mod_id, (conflicting_mods, conflicting_files))| {
            let file_hashes = sources
                .get(&mod_id)
                .map(|mod_sources| {
                    let wanted: Vec<(&String, &FileSource)> = conflicting_files
                        .iter()
                        .filter_map(|f| mod_sources.get(f).map(|s| (f, s)))
                        .collect();
                    fingerprint_files(&wanted)
                })
                .unwrap_or_default();
            let total_files = sources.get(&mod_id).map_or(0, |m| m.len());
            ModConflict {
                mod_id,
                conflicting_mods,
                conflicting_files,
                file_hashes,
                total_files,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_pak(path: &std::path::Path, files: &[&str]) {
        write_pak_mounted(path, "../../../", files);
    }

    fn write_pak_mounted(path: &std::path::Path, mount: &str, files: &[&str]) {
        let file = fs::File::create(path).unwrap();
        let mut writer = repak::PakBuilder::new().writer(
            std::io::BufWriter::new(file),
            repak::Version::V11,
            mount.to_string(),
            None,
        );
        for f in files {
            writer.write_file(f, false, b"data".to_vec()).unwrap();
        }
        writer.write_index().unwrap();
    }

    fn write_pak_with(path: &std::path::Path, files: &[(&str, &[u8])]) {
        let file = fs::File::create(path).unwrap();
        let mut writer = repak::PakBuilder::new().writer(
            std::io::BufWriter::new(file),
            repak::Version::V11,
            "../../../".to_string(),
            None,
        );
        for (name, data) in files {
            writer.write_file(name, false, data.to_vec()).unwrap();
        }
        writer.write_index().unwrap();
    }

    fn info(id: i64, path: &std::path::Path) -> ConflictCheckModInfo {
        serde_json::from_value(serde_json::json!({
            "mod_id": id,
            "cache_path": path.to_str().unwrap(),
            "is_unpacked": false,
        }))
        .unwrap()
    }

    #[test]
    fn reports_real_overlaps_and_ignores_files_the_installer_skips() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.pak");
        let b = dir.path().join("b.pak");
        let c = dir.path().join("c.pak");
        write_pak(&a, &["FSD/Content/Gun.uasset", "FSD/Content/Gun.uexp", "FSD/AssetRegistry.bin"]);
        write_pak(&b, &["FSD/Content/Gun.uasset", "FSD/Content/Gun.uexp", "FSD/AssetRegistry.bin"]);
        // Shares only skipped files with the others: must not be a conflict
        write_pak(&c, &["FSD/Content/Other.uasset", "FSD/AssetRegistry.bin", "FSD/Content/S.ushaderbytecode"]);

        let mut result = check_mod_conflicts(&[info(1, &a), info(2, &b), info(3, &c)], None);
        result.sort_by_key(|m| m.mod_id);

        assert_eq!(result.len(), 2, "only mods 1 and 2 conflict: {:?}", result.iter().map(|m| m.mod_id).collect::<Vec<_>>());
        assert_eq!(result[0].mod_id, 1);
        assert_eq!(result[0].conflicting_mods, vec![2]);
        let mut files = result[0].conflicting_files.clone();
        files.sort();
        assert_eq!(files, vec!["fsd/content/gun.uasset", "fsd/content/gun.uexp"]);
    }

    #[test]
    fn detects_conflicts_across_different_mount_points() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.pak");
        let d = dir.path().join("d.pak");
        write_pak(&a, &["FSD/Content/Gun.uasset"]);
        write_pak_mounted(&d, "../../../FSD/", &["Content/Gun.uasset"]);

        let result = check_mod_conflicts(&[info(1, &a), info(4, &d)], None);
        assert_eq!(result.len(), 2);
        for m in &result {
            assert_eq!(m.conflicting_files, vec!["fsd/content/gun.uasset"]);
        }
    }

    #[test]
    fn fingerprints_tell_identical_files_from_different_ones() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.pak");
        let b = dir.path().join("b.pak");
        write_pak_with(&a, &[("FSD/Content/Shared.uasset", b"same bytes"), ("FSD/Content/Gun.uasset", b"gun A")]);
        write_pak_with(&b, &[("FSD/Content/Shared.uasset", b"same bytes"), ("FSD/Content/Gun.uasset", b"gun B")]);

        // An unpacked folder mod with the same shared file
        let unpacked = dir.path().join("unpacked");
        fs::create_dir_all(unpacked.join("Content")).unwrap();
        fs::write(unpacked.join("Content").join("Shared.uasset"), b"same bytes").unwrap();
        let unpacked_info: ConflictCheckModInfo = serde_json::from_value(serde_json::json!({
            "mod_id": 3, "cache_path": unpacked.to_str().unwrap(), "is_unpacked": true,
        })).unwrap();

        let result = check_mod_conflicts(&[info(1, &a), info(2, &b), unpacked_info], None);
        let by_id: HashMap<i64, &ModConflict> = result.iter().map(|m| (m.mod_id, m)).collect();
        let h = |id: i64, f: &str| by_id[&id].file_hashes.get(f).cloned();

        assert!(h(1, "fsd/content/shared.uasset").is_some());
        assert_eq!(h(1, "fsd/content/shared.uasset"), h(2, "fsd/content/shared.uasset"));
        assert_eq!(h(1, "fsd/content/shared.uasset"), h(3, "fsd/content/shared.uasset"));
        assert_ne!(h(1, "fsd/content/gun.uasset"), h(2, "fsd/content/gun.uasset"));
        assert!(h(3, "fsd/content/gun.uasset").is_none(), "mod 3 doesn't have the gun");
        assert_eq!((by_id[&1].total_files, by_id[&3].total_files), (2, 1));
    }
}
