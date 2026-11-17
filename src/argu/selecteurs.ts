/**
 * Sélecteurs DOM lus par l'extension sur X et YouTube, servis par GET /capture/config : quand
 * ces sites changent leur page, on corrige ici et on redéploie le serveur, sans republier
 * l'extension. `version` permet à l'extension de signaler quelle configuration elle a utilisée.
 */
export const SELECTEURS = {
  version: 1,
  x: {
    post: 'article[data-testid="tweet"]',
    texte: '[data-testid="tweetText"]',
    auteurNom: '[data-testid="User-Name"] a span',
    auteurIdentifiant: '[data-testid="User-Name"] a[href^="/"][tabindex="-1"]',
    date: "time[datetime]",
    lienPermanent: 'a[href*="/status/"]:has(time)',
    citation: '[data-testid="quoteTweet"], div[role="link"][tabindex="0"]',
  },
  youtube: {
    titre: "h1.ytd-watch-metadata yt-formatted-string, h1.title",
    chaine: "ytd-channel-name#channel-name a, #owner #channel-name a",
    date: 'meta[itemprop="uploadDate"], meta[itemprop="datePublished"]',
    transcriptionSegments: "ytd-transcript-segment-renderer",
    transcriptionTexte: ".segment-text",
    transcriptionHorodatage: ".segment-timestamp",
  },
} as const;
