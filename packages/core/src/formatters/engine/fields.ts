/**
 * The `<section>.<property>` names templates may reference.
 *
 * A field present in `convertStreamToParseValue` but missing here degrades
 * every template referencing it to literal text.
 */

export const FIELD_REGISTRY: Readonly<Record<string, readonly string[]>> = {
  config: ['addonName'],
  stream: [
    'filename',
    'folderName',
    'size',
    'bitrate',
    'folderSize',
    'library',
    'quality',
    'resolution',
    'subbed',
    'dubbed',
    'languages',
    'uLanguages',
    'subtitles',
    'uSubtitles',
    'languageEmojis',
    'uLanguageEmojis',
    'subtitleEmojis',
    'uSubtitleEmojis',
    'languageCodes',
    'uLanguageCodes',
    'subtitleCodes',
    'uSubtitleCodes',
    'smallLanguageCodes',
    'uSmallLanguageCodes',
    'smallSubtitleCodes',
    'uSmallSubtitleCodes',
    'wedontknowwhatakilometeris',
    'uWedontknowwhatakilometeris',
    'visualTags',
    'audioTags',
    'releaseGroup',
    'regexMatched',
    'rankedRegexMatched',
    'regexScore',
    'nRegexScore',
    'encode',
    'audioChannels',
    'edition',
    'editions',
    'remastered',
    'regraded',
    'repack',
    'uncensored',
    'unrated',
    'upscaled',
    'hasChapters',
    'network',
    'container',
    'extension',
    'indexer',
    'year',
    'title',
    'date',
    'folderSeasons',
    'formattedFolderSeasons',
    'seasons',
    'season',
    'formattedSeasons',
    'episodes',
    'episode',
    'formattedEpisodes',
    'folderEpisodes',
    'formattedFolderEpisodes',
    'seasonEpisode',
    'seasonPack',
    'seeders',
    'private',
    'freeleech',
    'age',
    'ageHours',
    'duration',
    'infoHash',
    'type',
    'message',
    'proxied',
    'seadex',
    'seadexBest',
    'seScore',
    'nSeScore',
    'seMatched',
    'rseMatched',
    'preloading',
  ],
  metadata: [
    'queryType',
    'title',
    'runtime',
    'genres',
    'year',
    'episodeRuntime',
  ],
  service: ['id', 'shortName', 'name', 'cached'],
  addon: ['name', 'presetId', 'manifestUrl'],
  debug: ['json', 'jsonf'],
} as const;

/** Lower-cased name to its canonical spelling, so field names are case-insensitive. */
const CANONICAL_FIELDS: ReadonlyMap<string, [string, string]> = new Map(
  Object.entries(FIELD_REGISTRY).flatMap(([section, properties]) =>
    properties.map(
      (property) =>
        [`${section}.${property}`.toLowerCase(), [section, property]] as [
          string,
          [string, string],
        ]
    )
  )
);

/** Returns the canonical `[section, property]`, or undefined if unknown. */
export function canonicaliseField(
  section: string,
  property: string
): [string, string] | undefined {
  return CANONICAL_FIELDS.get(`${section}.${property}`.toLowerCase());
}
