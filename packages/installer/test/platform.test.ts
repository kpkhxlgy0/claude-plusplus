import assert from "node:assert/strict";
import test from "node:test";
import { discoverClaudeInstall, parseClaudeAppxPackageJson } from "../src/platform.ts";

const installLocation = "C:\\Program Files\\WindowsApps\\Claude_1.26832.0.0_x64__pzs8sxrjxfjjc";

test("parses a Claude Appx record into verified executable and ASAR paths", () => {
  const install = parseClaudeAppxPackageJson(
    JSON.stringify({
      Name: "Claude",
      Version: "1.26832.0.0",
      InstallLocation: installLocation,
      PackageFullName: "Claude_1.26832.0.0_x64__pzs8sxrjxfjjc",
    }),
    () => true,
  );

  assert.deepEqual(install, {
    packageFullName: "Claude_1.26832.0.0_x64__pzs8sxrjxfjjc",
    packageVersion: "1.26832.0.0",
    installLocation,
    appRoot: `${installLocation}\\app`,
    executablePath: `${installLocation}\\app\\claude.exe`,
    resourcesPath: `${installLocation}\\app\\resources`,
    asarPath: `${installLocation}\\app\\resources\\app.asar`,
  });
});

test("rejects Appx metadata when the executable or ASAR is missing", () => {
  const raw = JSON.stringify({
    Name: "Claude",
    Version: "1.26832.0.0",
    InstallLocation: installLocation,
    PackageFullName: "Claude_1.26832.0.0_x64__pzs8sxrjxfjjc",
  });

  assert.throws(
    () => parseClaudeAppxPackageJson(raw, (path) => !path.endsWith("app.asar")),
    /app\.asar.*missing/i,
  );
});

test("discovers Claude through the exact Get-AppxPackage query", async () => {
  const raw = JSON.stringify({
    Name: "Claude",
    Version: "1.26832.0.0",
    InstallLocation: installLocation,
    PackageFullName: "Claude_1.26832.0.0_x64__pzs8sxrjxfjjc",
  });
  let receivedScript = "";

  const install = await discoverClaudeInstall({
    runPowerShell: async (script) => {
      receivedScript = script;
      return raw;
    },
    pathExists: () => true,
  });

  assert.equal(install.packageVersion, "1.26832.0.0");
  assert.match(receivedScript, /Get-AppxPackage -Name Claude/);
  assert.match(receivedScript, /Sort-Object Version -Descending/);
  assert.match(receivedScript, /Select-Object -First 1/);
});
