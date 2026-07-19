import { z } from 'zod';
import { Cache } from '../utils/cache.js';
import { appConfig } from '../utils/index.js';
import { makeRequest } from '../utils/http.js';
import { createLogger } from '../logging/logger.js';
import { Metadata } from './utils.js';

const logger = createLogger('skyhook');

// Sonarr's keyless TVDB proxy.

const SKYHOOK_BASE = 'https://skyhook.sonarr.tv/v1/tvdb/shows/en';

const SkyhookEpisodeSchema = z.looseObject({
  seasonNumber: z.number().optional(),
  episodeNumber: z.number().optional(),
  airDate: z.string().nullable().optional(),
});

const SkyhookShowSchema = z.looseObject({
  tvdbId: z.number(),
  title: z.string(),
  imdbId: z.string().nullable().optional(),
  tmdbId: z.number().nullable().optional(),
  originalLanguage: z.string().nullable().optional(),
  firstAired: z.string().nullable().optional(),
  lastAired: z.string().nullable().optional(),
  genres: z.array(z.string()).nullable().optional(),
  runtime: z.number().nullable().optional(),
  episodes: z.array(SkyhookEpisodeSchema).nullable().optional(),
});

export type SkyhookShow = z.infer<typeof SkyhookShowSchema>;

// iso 639-2 (skyhook) -> iso 639-1, only the codes we care about for title logic
const ISO6392_TO_1: Record<string, string> = {
  eng: 'en',
  zho: 'zh',
  jpn: 'ja',
  kor: 'ko',
  tha: 'th',
};

export class SkyhookMetadata {
  private static readonly cache = Cache.getInstance<number, SkyhookShow | null>(
    'skyhook:show'
  );

  public async getShow(tvdbId: number): Promise<SkyhookShow | null> {
    return SkyhookMetadata.cache.wrap(
      async () => {
        try {
          const response = await makeRequest(`${SKYHOOK_BASE}/${tvdbId}`, {
            method: 'GET',
            timeout: 5000,
            headers: { 'User-Agent': appConfig.http.defaultUserAgent },
          });
          if (!response.ok) return null;
          return SkyhookShowSchema.parse(await response.json());
        } catch (error) {
          logger.debug(`skyhook lookup failed for tvdb ${tvdbId}: ${error}`);
          return null;
        }
      },
      tvdbId,
      24 * 60 * 60 // 1 day
    );
  }

  public async getMetadata(tvdbId: number): Promise<Metadata | undefined> {
    const show = await this.getShow(tvdbId);
    if (!show) return undefined;
    const seasonCounts = new Map<number, Set<number>>();
    for (const ep of show.episodes ?? []) {
      if (
        typeof ep.seasonNumber !== 'number' ||
        typeof ep.episodeNumber !== 'number'
      )
        continue;
      if (!seasonCounts.has(ep.seasonNumber))
        seasonCounts.set(ep.seasonNumber, new Set());
      seasonCounts.get(ep.seasonNumber)!.add(ep.episodeNumber);
    }
    const seasons = [...seasonCounts.entries()]
      .map(([season_number, eps]) => ({
        season_number,
        episode_count: eps.size,
      }))
      .sort((a, b) => a.season_number - b.season_number);
    const year = show.firstAired
      ? new Date(show.firstAired).getFullYear()
      : undefined;
    return {
      title: show.title,
      titles: [{ title: show.title, language: 'en' }],
      year: Number.isNaN(year) ? undefined : year,
      originalLanguage: show.originalLanguage
        ? (ISO6392_TO_1[show.originalLanguage] ?? show.originalLanguage)
        : undefined,
      seasons: seasons.length ? seasons : undefined,
      genres: show.genres ?? undefined,
      tmdbId: show.tmdbId ?? null,
      tvdbId: show.tvdbId,
      firstAiredDate: show.firstAired ?? undefined,
      lastAiredDate: show.lastAired ?? undefined,
      runtime: show.runtime ?? undefined,
    };
  }

  /** Per-episode air dates for a season, shaped like the TVDB fetcher. */
  public async getSeasonEpisodes(
    tvdbId: number,
    seasonNumber: number
  ): Promise<{ number: number; aired: string | null }[] | undefined> {
    const show = await this.getShow(tvdbId);
    if (!show?.episodes) return undefined;
    return show.episodes
      .filter((e) => e.seasonNumber === seasonNumber && e.episodeNumber != null)
      .map((e) => ({ number: e.episodeNumber!, aired: e.airDate ?? null }));
  }
}
