import type { Pool } from "pg";
import { EMBEDDING_DIMENSION } from "../config.js";
import type { Canal, SourceType } from "./types.js";

/**
 * Tables de l'argumentaire (spec « collecte et consolidation d'argumentaires »).
 *
 * L'unité de travail est l'affirmation, pas le document : une capture contient souvent plusieurs
 * idées. Les captures sont gardées sans limite (hors du workflow `purge` et de MEMORY_DAYS) ;
 * seule la suppression explicite, par capture ou par auteur, les efface.
 */
export class ArguStore {
  private ready?: Promise<void>;

  constructor(private readonly pool: Pool) {}

  init(): Promise<void> {
    this.ready ??= this.pool
      .query(`
        CREATE EXTENSION IF NOT EXISTS vector;

        -- Contenu brut reçu, tenu pour authentique (seule l'équipe capture).
        CREATE TABLE IF NOT EXISTS aec_captures (
          id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          source_type         text NOT NULL CHECK (source_type IN ('x', 'youtube', 'telegram_texte', 'telegram_image', 'rss', 'assemblee', 'web')),
          url                 text,
          texte               text NOT NULL,
          auteur_nom          text,
          auteur_identifiant  text,
          auteur_type         text CHECK (auteur_type IN ('personnalite', 'organisation', 'media', 'particulier', 'inconnu')),
          -- Appartenance déclarée seulement (parti, fonction, média), jamais supposée par le modèle.
          auteur_affiliation  text,
          publie_le           timestamptz,
          extras              jsonb NOT NULL DEFAULT '{}'::jsonb,
          note                text,
          -- Pseudonyme u_… du membre, ou « collecte » pour les sources automatiques.
          capture_par         text NOT NULL,
          canal               text NOT NULL,
          -- SHA-256 de l'URL normalisée et du texte normalisé : refuse les doublons.
          empreinte           text NOT NULL UNIQUE,
          statut              text NOT NULL DEFAULT 'recue' CHECK (statut IN ('recue', 'traitee', 'erreur')),
          cree_le             timestamptz NOT NULL DEFAULT now()
        );
        -- Profil déduit de l'émetteur (classe sociale, orientation politique), particuliers compris.
        -- Donnée sensible au sens du RGPD : visible de l'équipe seulement, jamais indexée ni montrée
        -- aux militants, effacée avec la capture (donc avec la suppression par auteur).
        ALTER TABLE aec_captures ADD COLUMN IF NOT EXISTS emetteur_profil jsonb;
        CREATE INDEX IF NOT EXISTS aec_captures_auteur ON aec_captures (auteur_identifiant);
        CREATE INDEX IF NOT EXISTS aec_captures_par ON aec_captures (capture_par, canal, cree_le DESC);

        -- Le regroupement : une objection, ses variantes et sa réponse.
        CREATE TABLE IF NOT EXISTS aec_objections (
          id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          intitule           text NOT NULL,
          reformulations     text[] NOT NULL DEFAULT '{}',
          theme              text,
          reponse_courte     text,
          reponse_detaillee  text,
          points_appui       jsonb NOT NULL DEFAULT '[]'::jsonb,
          -- « Sans réponse assumée » : retirée de la liste de travail sans être publiée.
          sans_reponse       boolean NOT NULL DEFAULT false,
          statut             text NOT NULL DEFAULT 'a_ecrire' CHECK (statut IN ('a_ecrire', 'brouillon', 'validee')),
          embedding          vector(${EMBEDDING_DIMENSION}),
          cree_le            timestamptz NOT NULL DEFAULT now(),
          modifie_le         timestamptz NOT NULL DEFAULT now()
        );

        -- Une idée extraite d'une capture, classée et évaluée par le workflow consolidation.
        CREATE TABLE IF NOT EXISTS aec_affirmations (
          id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          capture_id             uuid NOT NULL REFERENCES aec_captures (id) ON DELETE CASCADE,
          texte                  text NOT NULL,
          -- Extrait mot pour mot de aec_captures.texte, vérifié par le code.
          citation               text NOT NULL,
          types                  text[] NOT NULL DEFAULT '{}',
          position               text CHECK (position IN ('pour', 'contre', 'neutre')),
          theme                  text,
          registre               text,
          force                  jsonb NOT NULL DEFAULT '{}'::jsonb,
          publics                jsonb NOT NULL DEFAULT '[]'::jsonb,
          familles               jsonb NOT NULL DEFAULT '[]'::jsonb,
          passages_programme     jsonb NOT NULL DEFAULT '[]'::jsonb,
          verification_url       text,
          -- fake_news retiré faute de source de vérification : à vérifier par l'équipe.
          a_verifier             boolean NOT NULL DEFAULT false,
          objection_id           uuid REFERENCES aec_objections (id) ON DELETE SET NULL,
          objection_proposee_id  uuid REFERENCES aec_objections (id) ON DELETE SET NULL,
          -- Les trois objections proches proposées, avec leur score : aucune fusion sans confirmation.
          propositions           jsonb NOT NULL DEFAULT '[]'::jsonb,
          statut                 text NOT NULL DEFAULT 'brouillon' CHECK (statut IN ('brouillon', 'validee', 'rejetee')),
          validee_par            text,
          validee_le             timestamptz,
          embedding              vector(${EMBEDDING_DIMENSION}),
          cree_le                timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS aec_affirmations_capture ON aec_affirmations (capture_id);
        CREATE INDEX IF NOT EXISTS aec_affirmations_objection ON aec_affirmations (objection_id);

        -- Listes éditables par l'équipe, injectées dans les prompts. Désactiver une entrée ne
        -- touche pas aux fiches déjà classées : elle disparaît seulement des choix proposés.
        CREATE TABLE IF NOT EXISTS aec_referentiels (
          type         text NOT NULL,
          code         text NOT NULL,
          libelle      text NOT NULL,
          description  text,
          actif        boolean NOT NULL DEFAULT true,
          ordre        integer NOT NULL DEFAULT 0,
          PRIMARY KEY (type, code)
        );

        -- Jetons de l'extension : seule l'empreinte est stockée, le jeton n'est montré qu'une fois.
        CREATE TABLE IF NOT EXISTS aec_jetons (
          empreinte      text PRIMARY KEY,
          pseudonyme     text NOT NULL,
          cree_le        timestamptz NOT NULL DEFAULT now(),
          dernier_usage  timestamptz,
          revoque_le     timestamptz
        );
        CREATE INDEX IF NOT EXISTS aec_jetons_pseudo ON aec_jetons (pseudonyme) WHERE revoque_le IS NULL;

        INSERT INTO aec_referentiels (type, code, libelle, description, ordre) VALUES
          ('categorie', 'argument',  'Argument',    'Un argument en faveur du programme', 1),
          ('categorie', 'critique',  'Critique',    'Une attaque publique d''un opposant contre le programme', 2),
          ('categorie', 'objection', 'Objection',   'Ce qu''un électeur répond à un militant', 3),
          ('categorie', 'debunk',    'Vérification','Un démenti sourcé d''une affirmation fausse', 4),
          ('categorie', 'fake_news', 'Fausse information', 'Une affirmation démentie par une source de vérification', 5),

          -- Classe sociale de l'émetteur, calquée sur les catégories socioprofessionnelles de l'Insee.
          -- « indetermine » n'est pas une entrée : c'est la valeur par défaut, toujours permise.
          ('classe_sociale', 'ouvrier',                  'Ouvrier',                  'Ouvrier, y compris agricole, qualifié ou non', 1),
          ('classe_sociale', 'employe',                  'Employé',                  'Employé du public ou du privé : commerce, services, administration, soin', 2),
          ('classe_sociale', 'profession_intermediaire', 'Profession intermédiaire', 'Technicien, agent de maîtrise, enseignant du primaire, infirmier, travailleur social', 3),
          ('classe_sociale', 'cadre',                    'Cadre',                    'Cadre et profession intellectuelle supérieure : ingénieur, profession libérale, enseignant du secondaire et du supérieur', 4),
          ('classe_sociale', 'artisan_commercant',       'Artisan, commerçant',      'Indépendant à son compte, avec peu ou pas de salariés', 5),
          ('classe_sociale', 'chef_entreprise',          'Chef d''entreprise',       'Dirigeant d''une entreprise de dix salariés ou plus', 6),
          ('classe_sociale', 'agriculteur',              'Agriculteur exploitant',   'Exploitant agricole à son compte', 7),
          ('classe_sociale', 'retraite',                 'Retraité',                 'Ancien actif à la retraite, quelle que soit sa profession passée', 8),
          ('classe_sociale', 'etudiant',                 'Étudiant, lycéen',         'En formation initiale', 9),
          ('classe_sociale', 'sans_emploi',              'Sans emploi',              'Chômeur ou personne sans activité professionnelle', 10),

          -- Famille politique de l'émetteur, de la gauche vers la droite, puis hors de cet axe.
          ('famille', 'extreme_gauche',    'Extrême gauche',    NULL, 1),
          ('famille', 'gauche_radicale',   'Gauche radicale',   NULL, 2),
          ('famille', 'sociaux_liberaux',  'Sociaux-libéraux',  NULL, 3),
          ('famille', 'droite_liberale',   'Droite libérale',   NULL, 4),
          ('famille', 'extreme_droite',    'Extrême droite',    NULL, 5),
          ('famille', 'libertarien',       'Libertarien',       NULL, 6)
        ON CONFLICT (type, code) DO NOTHING;
      `)
      .then(() => undefined);
    return this.ready;
  }

  /**
   * Enregistre une capture, ou renvoie celle qui a déjà la même empreinte. L'insertion et la
   * détection du doublon se font en une requête : deux envois simultanés ne créent qu'une ligne.
   */
  async insererCapture(c: NouvelleCapture): Promise<{ id: string; doublon: boolean }> {
    await this.init();
    const { rows } = await this.pool.query(
      `INSERT INTO aec_captures
         (source_type, url, texte, auteur_nom, auteur_identifiant, publie_le, extras, note, capture_par, canal, empreinte)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (empreinte) DO NOTHING
       RETURNING id`,
      [
        c.sourceType, c.url ?? null, c.texte, c.auteurNom ?? null, c.auteurIdentifiant ?? null,
        c.publieLe ?? null, JSON.stringify(c.extras ?? {}), c.note ?? null, c.capturePar, c.canal, c.empreinte,
      ],
    );
    if (rows[0]) return { id: rows[0].id as string, doublon: false };
    const existing = await this.pool.query(`SELECT id FROM aec_captures WHERE empreinte = $1`, [c.empreinte]);
    return { id: existing.rows[0].id as string, doublon: true };
  }

  async capture(id: string): Promise<CaptureRow | undefined> {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT id, source_type AS "sourceType", url, texte, auteur_nom AS "auteurNom",
              auteur_identifiant AS "auteurIdentifiant", publie_le AS "publieLe", extras, note,
              capture_par AS "capturePar", canal, statut, cree_le AS "creeLe",
              emetteur_profil AS "emetteurProfil"
         FROM aec_captures WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  /** Enregistre (ou remplace, après correction par l'équipe) le profil de l'émetteur d'une capture. */
  async enregistrerProfilEmetteur(captureId: string, profil: ProfilEmetteur): Promise<boolean> {
    await this.init();
    const { rowCount } = await this.pool.query(`UPDATE aec_captures SET emetteur_profil = $2 WHERE id = $1`, [
      captureId,
      JSON.stringify(profil),
    ]);
    return (rowCount ?? 0) > 0;
  }

  /** Captures faites par ce membre sur ce canal dans les dernières `heures` (quota par jeton). */
  async capturesRecentes(capturePar: string, canal: Canal, heures = 24): Promise<number> {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS n FROM aec_captures
        WHERE capture_par = $1 AND canal = $2 AND cree_le > now() - make_interval(hours => $3)`,
      [capturePar, canal, heures],
    );
    return rows[0].n as number;
  }

  /** Supprime une capture et, en cascade, ses affirmations. */
  async supprimerCapture(id: string): Promise<boolean> {
    await this.init();
    const { rowCount } = await this.pool.query(`DELETE FROM aec_captures WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }

  /** Droit à l'effacement : toutes les captures d'un auteur (identifiant tel qu'affiché), et leurs affirmations. */
  async supprimerAuteur(identifiant: string): Promise<number> {
    await this.init();
    const { rowCount } = await this.pool.query(`DELETE FROM aec_captures WHERE auteur_identifiant = $1`, [identifiant]);
    return rowCount ?? 0;
  }

  async referentiel(type: string, { actifsSeulement = true } = {}): Promise<Referentiel[]> {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT type, code, libelle, description, actif, ordre FROM aec_referentiels
        WHERE type = $1 ${actifsSeulement ? "AND actif" : ""} ORDER BY ordre, libelle`,
      [type],
    );
    return rows;
  }

  /** Nouveau jeton actif pour ce membre ; les précédents sont révoqués (un seul jeton valable à la fois). */
  async remplacerJeton(pseudonyme: string, empreinte: string): Promise<void> {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE aec_jetons SET revoque_le = now() WHERE pseudonyme = $1 AND revoque_le IS NULL`, [pseudonyme]);
      await client.query(`INSERT INTO aec_jetons (empreinte, pseudonyme) VALUES ($1, $2)`, [empreinte, pseudonyme]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  /** Le pseudonyme du membre si le jeton est connu et non révoqué ; note la date d'usage. */
  async jetonActif(empreinte: string): Promise<string | undefined> {
    await this.init();
    const { rows } = await this.pool.query(
      `UPDATE aec_jetons SET dernier_usage = now() WHERE empreinte = $1 AND revoque_le IS NULL RETURNING pseudonyme`,
      [empreinte],
    );
    return rows[0]?.pseudonyme;
  }

  async revoquerJetons(pseudonyme: string): Promise<number> {
    await this.init();
    const { rowCount } = await this.pool.query(
      `UPDATE aec_jetons SET revoque_le = now() WHERE pseudonyme = $1 AND revoque_le IS NULL`,
      [pseudonyme],
    );
    return rowCount ?? 0;
  }
}

export interface NouvelleCapture {
  sourceType: SourceType;
  url?: string;
  texte: string;
  auteurNom?: string;
  auteurIdentifiant?: string;
  publieLe?: string;
  extras?: Record<string, unknown>;
  note?: string;
  capturePar: string;
  canal: Canal;
  empreinte: string;
}

export interface CaptureRow {
  id: string;
  sourceType: SourceType;
  url: string | null;
  texte: string;
  auteurNom: string | null;
  auteurIdentifiant: string | null;
  publieLe: Date | null;
  extras: Record<string, unknown>;
  note: string | null;
  capturePar: string;
  canal: Canal;
  statut: "recue" | "traitee" | "erreur";
  creeLe: Date;
  emetteurProfil: ProfilEmetteur | null;
}

/**
 * Un trait de l'émetteur. `indice` est l'extrait de la capture (texte ou champs auteur) qui fonde
 * la déduction : sans indice retrouvé mot pour mot, le trait vaut « indetermine ». La déduction
 * reste une hypothèse ; ce qui est déclaré prime, et la correction de l'équipe fait foi.
 */
export interface TraitEmetteur {
  /** Code d'un référentiel (`classe_sociale` ou `famille`), ou « indetermine ». */
  code: string;
  justification: string;
  indice: string | null;
  origine: "declare" | "deduit" | "corrige";
}

export interface ProfilEmetteur {
  classe_sociale: TraitEmetteur;
  orientation: TraitEmetteur;
  /** Modèle qui a fait la déduction, ou pseudonyme du relecteur qui l'a corrigée. */
  modele: string;
  evalue_le: string;
}

export interface Referentiel {
  type: string;
  code: string;
  libelle: string;
  description: string | null;
  actif: boolean;
  ordre: number;
}
