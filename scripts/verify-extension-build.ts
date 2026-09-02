import assert from "node:assert/strict"
import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const APPROVED_HOST_PERMISSIONS = [
  "http://127.0.0.1:8787/*",
  "https://www.nowcoder.com/*",
  "https://www.xiaohongshu.com/*",
  "https://*.xhscdn.com/*",
]

interface ExtensionManifest {
  manifest_version: number
  minimum_chrome_version: string
  permissions: string[]
  host_permissions: string[]
  side_panel: { default_path: string }
  background: { service_worker: string }
  action: { default_icon: Record<string, string> }
  icons: Record<string, string>
  optional_host_permissions?: unknown
  content_scripts?: unknown
  externally_connectable?: unknown
}

function assertPackagedFile(buildRoot: string, relativePath: string) {
  const absolutePath = path.resolve(buildRoot, relativePath)
  const relativeToBuild = path.relative(buildRoot, absolutePath)
  assert.equal(
    relativeToBuild.startsWith("..") || path.isAbsolute(relativeToBuild),
    false,
    `Packaged path escapes build root: ${relativePath}`,
  )
  const stats = statSync(absolutePath)
  assert.equal(stats.isFile(), true, `Missing packaged file: ${relativePath}`)
  assert.ok(stats.size > 0, `Packaged file is empty: ${relativePath}`)
}

export function verifyExtensionBuild(
  sourceManifestPath = path.resolve("extension/manifest.json"),
  buildRoot = path.resolve("dist-extension"),
) {
  const builtManifestPath = path.join(buildRoot, "manifest.json")
  const sourceManifestText = readFileSync(sourceManifestPath, "utf8")
  const builtManifestText = readFileSync(builtManifestPath, "utf8")
  assert.equal(
    builtManifestText,
    sourceManifestText,
    "Packaged manifest must exactly match extension/manifest.json",
  )

  const manifest = JSON.parse(builtManifestText) as ExtensionManifest
  assert.equal(manifest.manifest_version, 3)
  assert.equal(manifest.minimum_chrome_version, "116")
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ["activeTab", "scripting", "sidePanel", "storage"].sort(),
  )
  assert.deepEqual(manifest.host_permissions, APPROVED_HOST_PERMISSIONS)
  assert.equal(manifest.host_permissions.includes("<all_urls>"), false)
  assert.equal(manifest.host_permissions.includes("http://*/*"), false)
  assert.equal(manifest.host_permissions.includes("https://*/*"), false)
  assert.equal("optional_host_permissions" in manifest, false)
  assert.equal("content_scripts" in manifest, false)
  assert.equal("externally_connectable" in manifest, false)

  const manifestFiles = new Set([
    manifest.side_panel.default_path,
    manifest.background.service_worker,
    ...Object.values(manifest.action.default_icon),
    ...Object.values(manifest.icons),
  ])
  for (const relativePath of manifestFiles) {
    assertPackagedFile(buildRoot, relativePath)
  }

  const sidePanelHtml = readFileSync(
    path.join(buildRoot, manifest.side_panel.default_path),
    "utf8",
  )
  const htmlAssets = Array.from(
    sidePanelHtml.matchAll(/(?:src|href)="([^"#?]+)"/g),
    (match) => match[1]!,
  ).filter((value) => !/^[a-z]+:/i.test(value))
  assert.ok(htmlAssets.length > 0, "Packaged Side Panel must reference its built assets")
  for (const relativePath of htmlAssets) {
    assertPackagedFile(buildRoot, relativePath.replace(/^\//, ""))
  }

  return {
    manifestFiles: manifestFiles.size,
    htmlAssets: htmlAssets.length,
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ""
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = verifyExtensionBuild()
  console.log(
    `Verified extension package: ${result.manifestFiles} manifest assets, ${result.htmlAssets} HTML assets.`,
  )
}
