const platformOrder = [
  'Custom',
  'Steam',
  'Epic',
  'GOG',
  'Xbox',
  'EA',
  'Ubisoft',
  'Blizzard',
];
const rowTime = (game) =>
  (game && (game.latest_modified || game.latest_backup)) || '';

// Raw values from the data maps, not the cells; null sorts last.
const sortValueGetters = {
  size: (game) => Number(game && game.backup_size) || 0,
  count: (game) =>
    game && Array.isArray(game.backups) ? game.backups.length : 0,
  // Zero-padded YYYY/MM/DD HH:mm compares correctly as plain text.
  time: (game) =>
    /^\d{4}\/\d{2}\/\d{2}/.test(rowTime(game)) ? rowTime(game) : null,
  platform: (game) => {
    const ranks = ((game && game.platform) || [])
      .map((platform) => platformOrder.indexOf(platform))
      .filter((rank) => rank >= 0)
      .sort((a, b) => a - b);
    return ranks.length
      ? ranks.map((rank) => String(rank).padStart(2, '0')).join(',')
      : null;
  },
};

function orderEntries(entries, { key, direction }, byTitle) {
  const sign = direction === 'desc' ? -1 : 1;

  if (key === 'title') {
    return [...entries].sort((a, b) => byTitle(a, b) * sign);
  }

  const getValue = sortValueGetters[key] || (() => null);
  const withValue = [];
  const withoutValue = [];
  entries.forEach((entry) => {
    const value = getValue(entry.game);
    (value === null || value === undefined ? withoutValue : withValue).push({
      ...entry,
      value,
    });
  });

  // Direction flips the column only; ties stay alphabetical in both directions.
  withValue.sort((a, b) => {
    const primary =
      typeof a.value === 'number' && typeof b.value === 'number'
        ? a.value - b.value
        : String(a.value).localeCompare(String(b.value));
    return primary * sign || byTitle(a, b);
  });
  withoutValue.sort(byTitle);

  return [...withValue, ...withoutValue];
}

module.exports = { orderEntries, rowTime, platformOrder };
