const { execFile } = require('child_process');

const fsOriginal = require('original-fs');

const util = require('util');

const glob = require('glob');

const { getSettings } = require('../global');
const {
  getGameData,
  getAllAccountIds,
  resolvePlaceholder,
} = require('./gameData');
const {
  registryKeyExists,
  getRegistryChildNames,
} = require('../platform/registry');

const execFilePromise = util.promisify(execFile);

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Only * and ? are allowed as wildcards
function toGlobPattern(resolvedPath) {
  return resolvedPath.replace(/\\/g, '/').replace(/[[\]{}()!+@|]/g, '\\$&');
}

// Helper function to generate all combinations of UIDs for a given number of {{p|uid}}
function generateUidCombinations(count, allUids) {
  if (count === 0) return [[]];
  if (count === 1) return allUids.map((uid) => [uid]);

  const smaller = generateUidCombinations(count - 1, allUids);
  const result = [];
  for (const combo of smaller) {
    for (const uid of allUids) {
      result.push([...combo, uid]);
    }
  }
  return result;
}

// Helper function to reconstruct the final template from resolved placeholder mappings
function createFinalTemplate(resolvedPath, placeholderMappings) {
  let finalTemplate = resolvedPath.replace(/\\/g, '/');
  const sortedMappings = Object.entries(placeholderMappings).sort(
    (a, b) => b[1].length - a[1].length,
  );

  for (const [placeholder, resolvedValue] of sortedMappings) {
    const normalizedValue = resolvedValue.replace(/\\/g, '/');
    const escapedValue = escapeRegExp(normalizedValue);
    const regex = new RegExp(escapedValue, 'gi');
    finalTemplate = finalTemplate.replace(regex, placeholder);
  }

  return finalTemplate;
}

async function resolveTemplatedBackupPath(
  templatedPath,
  gameInstallPath,
  isRegistry = false,
) {
  // Track placeholder→value mappings for later reconstruction of finalTemplate
  const placeholderMappings = {};

  // Replace all non-uid placeholders while tracking mappings
  let basePath = templatedPath.replace(/\{\{p\|[^\}]+\}\}/gi, (match) => {
    const normalizedMatch = match.toLowerCase().replace(/\\/g, '/');
    if (normalizedMatch === '{{p|uid}}') {
      return '{{p|uid}}'; // resolved later, once per account
    }

    const replacement = resolvePlaceholder(normalizedMatch, gameInstallPath);
    if (replacement === null) {
      return normalizedMatch;
    }

    placeholderMappings[normalizedMatch] = replacement;
    return replacement;
  });

  // Final check for unresolved placeholders (except uid)
  if (
    /\{\{p\|[^\}]+\}\}/i.test(
      basePath.toLowerCase().replace(/\{\{p\|uid\}\}/gi, ''),
    )
  ) {
    console.warn(`Unresolved placeholder found in path: ${basePath}`);
    return [];
  }

  if (isRegistry) {
    // Registry paths require registry-key enumeration rather than filesystem globbing.
    return await fillRegistryPathUid(
      templatedPath,
      basePath,
      placeholderMappings,
    );
  }

  // For file paths, pass to fillPathUid to handle uid and wildcards
  return await fillPathUid(templatedPath, basePath, placeholderMappings);
}

async function fillPathUid(templatedPath, basePath, placeholderMappings) {
  // Stays sync: the async walk orders differently, and order names path1/path2
  function tryGlobAndReturnPaths(testPath) {
    // glob walks with patched fs, so it descends into a .asar; original-fs sees
    // those matches for what they are, paths that do not exist on disk.
    const files = glob.sync(toGlobPattern(testPath));
    if (files.length > 0) {
      return files
        .filter((filePath) => fsOriginal.existsSync(filePath))
        .map((filePath) => ({
          template: templatedPath,
          finalTemplate: createFinalTemplate(filePath, placeholderMappings),
          resolved: filePath,
        }));
    }
    return null;
  }

  // Find the latest modified path
  async function findLatestModifiedPath(paths) {
    let latestPath = null;
    let latestTime = 0;

    for (const filePath of paths) {
      const stats = fsOriginal.statSync(filePath);
      if (stats.mtimeMs > latestTime) {
        latestTime = stats.mtimeMs;
        latestPath = filePath;
      }
    }

    return latestPath;
  }

  // 1. If there's no uid placeholder, just handle wildcards
  if (!basePath.includes('{{p|uid}}')) {
    const result = tryGlobAndReturnPaths(basePath);
    return result || [];
  }

  // 2. For all accounts, skip context-aware and known UID matching and use wildcards
  if (getSettings().backupAllAccounts) {
    const wildcardPath = basePath.replace(/\{\{p\|uid\}\}/gi, '*');
    const result = tryGlobAndReturnPaths(wildcardPath);
    return result || [];
  }

  // Helper to apply context-aware UID replacement using regex
  const applyContextReplacement = (pathStr, fullPattern, uidValue) => {
    if (!fullPattern || !uidValue) return pathStr;

    const normalizedPattern = fullPattern.replace(/\\/g, '/');
    const normalizedPath = pathStr.replace(/\\/g, '/');

    const escapedPattern = escapeRegExp(normalizedPattern);
    const regex = new RegExp(escapedPattern, 'gi');

    const replacement = normalizedPattern.replace(/\{\{p\|uid\}\}/gi, uidValue);
    return normalizedPath.replace(regex, replacement);
  };

  const steamPath = getGameData().steamPath;
  const ubisoftPath = getGameData().ubisoftPath;
  const steamAccountId = getGameData().currentSteamAccountId;
  const ubisoftAccountId = getGameData().currentUbisoftAccountId;

  // 3. Apply platform-specific current-account replacements
  let contextAwarePath = basePath;
  contextAwarePath = applyContextReplacement(
    contextAwarePath,
    `${steamPath}/userdata/{{p|uid}}`,
    steamAccountId,
  );
  contextAwarePath = applyContextReplacement(
    contextAwarePath,
    `${ubisoftPath}/savegames/{{p|uid}}`,
    ubisoftAccountId,
  );

  // If all placeholders are context-aware, try glob directly
  if (!contextAwarePath.includes('{{p|uid}}')) {
    const result = tryGlobAndReturnPaths(contextAwarePath);
    return result || [];
  }

  // 4. Count and try known current-account IDs for remaining {{p|uid}} placeholders
  const uidMatches = contextAwarePath.match(/\{\{p\|uid\}\}/gi);
  const uidCount = uidMatches ? uidMatches.length : 0;

  if (uidCount === 0) {
    return [];
  }

  const uidValues = Object.values(getAllAccountIds()).filter(
    (uid) => uid && uid !== 'N/A' && uid !== null && uid !== undefined,
  );
  const uidCombinations = generateUidCombinations(uidCount, uidValues);

  for (const uidCombo of uidCombinations) {
    let testPath = contextAwarePath;

    // Replace each {{p|uid}} with the corresponding UID from the combination
    let uidIndex = 0;
    testPath = testPath.replace(/\{\{p\|uid\}\}/gi, () => {
      const uid = uidCombo[uidIndex];
      uidIndex++;
      return uid;
    });

    const result = tryGlobAndReturnPaths(testPath);
    if (result) {
      return result;
    }
  }

  // 5. Final fallback: select the newest wildcard match for UID
  const wildcardPath = basePath.replace(/\{\{p\|uid\}\}/gi, '*');
  const wildcardResolvedPaths = glob
    .sync(toGlobPattern(wildcardPath))
    .filter((filePath) => fsOriginal.existsSync(filePath));

  if (wildcardResolvedPaths.length === 0) {
    return [];
  }

  const latestPath = await findLatestModifiedPath(wildcardResolvedPaths);
  return [
    {
      template: templatedPath,
      finalTemplate: createFinalTemplate(latestPath, placeholderMappings),
      resolved: latestPath,
    },
  ];
}

async function fillRegistryPathUid(
  templatedPath,
  basePath,
  placeholderMappings,
) {
  // A trailing separator hides the key from reg.exe and escapes the quote on export
  basePath = basePath.replace(/\\+$/, '');

  function expandUidWildcards(registryPath) {
    const [hive, ...segments] = registryPath.split('\\').filter(Boolean);
    const uidSegmentIndex = segments.findIndex((segment) =>
      /\{\{p\|uid\}\}/i.test(segment),
    );

    if (uidSegmentIndex === -1) {
      return [registryPath];
    }

    const parentSegments = segments.slice(0, uidSegmentIndex);
    const parentPath =
      parentSegments.length > 0
        ? `${hive}\\${parentSegments.join('\\')}`
        : hive;
    const childNames = getRegistryChildNames(parentPath);
    const uidSegmentPattern = new RegExp(
      `^${segments[uidSegmentIndex]
        .split(/\{\{p\|uid\}\}/i)
        .map(escapeRegExp)
        .join('(.+)')}$`,
      'i',
    );
    const expandedPaths = [];

    for (const childName of childNames) {
      if (!uidSegmentPattern.test(childName)) continue;

      const candidateSegments = [...segments];
      candidateSegments[uidSegmentIndex] = childName;
      const candidatePath = `${hive}\\${candidateSegments.join('\\')}`;
      expandedPaths.push(...expandUidWildcards(candidatePath));
    }

    return expandedPaths;
  }

  const toResolvedPathObj = (resolvedPath) => ({
    template: templatedPath,
    finalTemplate: createFinalTemplate(resolvedPath, placeholderMappings),
    resolved: resolvedPath,
  });

  // 1. If there's no uid placeholder, return the concrete registry path
  if (!basePath.includes('{{p|uid}}')) {
    return [toResolvedPathObj(basePath)];
  }

  // 2. For all accounts, enumerate and return every matching registry key
  if (getSettings().backupAllAccounts) {
    const expandedPaths = expandUidWildcards(basePath);
    const existingPaths = [];
    for (const registryPath of expandedPaths) {
      if (registryKeyExists(registryPath)) {
        existingPaths.push(toResolvedPathObj(registryPath));
      }
    }
    return existingPaths;
  }

  // 3. Try known current-account IDs
  const uidMatches = basePath.match(/\{\{p\|uid\}\}/gi);
  const uidCount = uidMatches ? uidMatches.length : 0;
  const uidValues = Object.values(getAllAccountIds()).filter(
    (uid) => uid && uid !== 'N/A' && uid !== null && uid !== undefined,
  );
  const uidCombinations = generateUidCombinations(uidCount, uidValues);

  for (const uidCombo of uidCombinations) {
    let uidIndex = 0;
    const candidatePath = basePath.replace(
      /\{\{p\|uid\}\}/gi,
      () => uidCombo[uidIndex++],
    );
    if (registryKeyExists(candidatePath)) {
      return [toResolvedPathObj(candidatePath)];
    }
  }

  // 4. Fall back to the first wildcard match
  const expandedPaths = expandUidWildcards(basePath);
  for (const registryPath of expandedPaths) {
    if (registryKeyExists(registryPath)) {
      return [toResolvedPathObj(registryPath)];
    }
  }

  return [];
}

// ======================================================================
// Backing up
// ======================================================================
// The caller holds the game lock. Restore uses this with the actual preflighted
// destinations so a protection snapshot never guesses paths from the database.

module.exports = { resolveTemplatedBackupPath };
