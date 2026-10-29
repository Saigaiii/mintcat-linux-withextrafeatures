use anyhow::Context;
use mintcat_integrator_api::{ConflictCheckModInfo, ModConflict};
use std::collections::HashMap;
use std::fs;
use std::io::BufReader;
use walkdir::WalkDir;

fn get_pak_files(pak_path: &str) -> anyhow::Result<Vec<String>> {
    let file = fs::File::open(pak_path)
        .with_context(|| format!("Failed to open pak file: {}", pak_path))?;
    let mut reader = BufReader::new(file);

    let pak = repak::PakBuilder::new()
        .reader(&mut reader)
        .with_context(|| format!("Failed to parse pak file: {}", pak_path))?;

    let mount_point = pak.mount_point();
    let files: Vec<String> = pak
        .files()
        .iter()
        .map(|p| {
            // Paths in the index are relative to the mount point ("../../../" or
            // "../../../FSD/" etc.), so join them with a separator before comparing.
            let mount = mount_point.trim_end_matches('/');
            let file = p.trim_start_matches('/');
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
        })
        .collect();

    Ok(files)
}

fn content_prefix_for_game(game_name: Option<&str>) -> &'static str {
    match game_name {
        Some(name) if name.eq_ignore_ascii_case("rc") => "roguecore",
        _ => "fsd",
    }
}

fn get_unpacked_mod_files(dir_path: &str, content_prefix: &str) -> anyhow::Result<Vec<String>> {
    let path = std::path::Path::new(dir_path);
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
            files.push(pak_path);
        }
    }

    Ok(files)
}

fn get_directory_mod_pak_files(
    dir_path: &str,
    content_prefix: &str,
) -> anyhow::Result<Vec<String>> {
    let path = std::path::Path::new(dir_path);
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

    for mod_info in mods {
        let files = if mod_info.is_unpacked {
            get_directory_mod_pak_files(&mod_info.cache_path, content_prefix)
        } else {
            get_pak_files(&mod_info.cache_path)
        };

        match files {
            Ok(file_list) => {
                for file_path in file_list {
                    // The installer never writes these from mods (see pak_integrator),
                    // so they can't conflict in practice.
                    if file_path.ends_with("assetregistry.bin")
                        || file_path.ends_with(".ushaderbytecode")
                    {
                        continue;
                    }
                    let ids = file_to_mods.entry(file_path).or_default();
                    // A mod with several paks can list a path twice; that's not a conflict
                    if !ids.contains(&mod_info.mod_id) {
                        ids.push(mod_info.mod_id);
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
        .map(
            |(mod_id, (conflicting_mods, conflicting_files))| ModConflict {
                mod_id,
                conflicting_mods,
                conflicting_files,
            },
        )
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
}
