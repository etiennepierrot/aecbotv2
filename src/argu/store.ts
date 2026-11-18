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
        -- Consolidation : quand elle a eu lieu (plafond quotidien), et pourquoi elle a échoué.
        ALTER TABLE aec_captures ADD COLUMN IF NOT EXISTS traitee_le timestamptz;
        ALTER TABLE aec_captures ADD COLUMN IF NOT EXISTS erreur text;
        -- Même journal que les ajouts au corpus (src/corpus/store.ts), créé ici aussi s'il manque.
        CREATE TABLE IF NOT EXISTS aec_admin_log (
          id       bigserial PRIMARY KEY,
          at       timestamptz NOT NULL DEFAULT now(),
          who      text NOT NULL,
          action   text NOT NULL,
          doc_id   text,
          title    text,
          detail   text
        );
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
          ('famille', 'extreme_gauche',       'Extrême gauche',       NULL, 1),
          ('famille', 'gauche_radicale',      'Gauche radicale',      NULL, 2),
          ('famille', 'ecologistes',          'Écologistes',          'Écologie politique', 3),
          ('famille', 'sociaux_liberaux',     'Sociaux-libéraux',     NULL, 4),
          ('famille', 'centre',               'Centre',               'Centre et centre-droit libéral', 5),
          ('famille', 'droite_liberale',      'Droite libérale',      NULL, 6),
          ('famille', 'droite_conservatrice', 'Droite conservatrice', 'Droite traditionnelle, conservatrice sur les questions de société', 7),
          ('famille', 'extreme_droite',       'Extrême droite',       NULL, 8),
          ('famille', 'souverainistes',       'Souverainistes',       'Priorité à la souveraineté nationale, de gauche comme de droite', 9),
          ('famille', 'libertarien',          'Libertarien',          NULL, 10),

          -- Publics : à qui parle l'argument (profils de terrain), quel que soit son émetteur.
          ('public', 'quartiers_populaires', 'Quartiers populaires',          'Habitants des grands ensembles urbains', 1),
          ('public', 'rural_periurbain',     'Rural et périurbain',           'Dépendance à la voiture, éloignement des services publics', 2),
          ('public', 'jeunes',               'Jeunes',                        'Étudiants, lycéens, primo-votants, précarité d''entrée dans la vie active', 3),
          ('public', 'retraites',            'Retraités',                     'Niveau des pensions, santé, dépendance', 4),
          ('public', 'salaries_modestes',    'Salariés modestes',             'Smic, temps partiel, emplois pénibles', 5),
          ('public', 'classes_moyennes',     'Classes moyennes salariées',    'Fiscalité, logement, école', 6),
          ('public', 'fonctionnaires',       'Fonctionnaires et agents publics', 'Salaires, conditions de travail, sens du service public', 7),
          ('public', 'independants',         'Indépendants et petits patrons', 'Charges, trésorerie, concurrence des grands groupes', 8),
          ('public', 'agriculteurs',         'Agriculteurs',                  'Revenus, normes, libre-échange', 9),
          ('public', 'abstentionnistes',     'Abstentionnistes et déçus',     'Défiance envers les institutions et les partis', 10),

          -- Thèmes, alignés sur les grands chapitres du programme pour le rapprochement avec ses passages.
          ('theme', 'salaires_pouvoir_achat', 'Salaires et pouvoir d''achat', NULL, 1),
          ('theme', 'retraites',              'Retraites',                    NULL, 2),
          ('theme', 'fiscalite',              'Fiscalité et partage des richesses', NULL, 3),
          ('theme', 'dette_finances',         'Dette et finances publiques',  NULL, 4),
          ('theme', 'services_publics',       'Services publics',             'Santé, école, transports', 5),
          ('theme', 'logement',               'Logement',                     NULL, 6),
          ('theme', 'ecologie_planification', 'Écologie et planification',    NULL, 7),
          ('theme', 'energie',                'Énergie',                      NULL, 8),
          ('theme', 'institutions',           'Institutions et 6e République', NULL, 9),
          ('theme', 'securite_justice',       'Sécurité et justice',          NULL, 10),
          ('theme', 'immigration',            'Immigration',                  NULL, 11),
          ('theme', 'europe_international',   'Europe et international',      NULL, 12),
          ('theme', 'travail_emploi',         'Travail et emploi',            NULL, 13),
          ('theme', 'agriculture_alimentation', 'Agriculture et alimentation', NULL, 14),

          -- Registres : la façon dont l'argument cherche à convaincre.
          ('registre', 'cout_faisabilite',     'Coût et faisabilité',          '« C''est infinançable », « qui va payer »', 1),
          ('registre', 'pouvoir_achat',        'Pouvoir d''achat et vie quotidienne', 'Prix, factures, plein d''essence', 2),
          ('registre', 'peur_menace',          'Peur et menace',               'Fuite des capitaux, chaos, effondrement', 3),
          ('registre', 'valeurs_morale',       'Valeurs et morale',            'Mérite, travail, justice, assistanat', 4),
          ('registre', 'identite',             'Identité et appartenance',     'Nation, culture, « eux et nous »', 5),
          ('registre', 'securite_ordre',       'Sécurité et ordre',            NULL, 6),
          ('registre', 'expertise_chiffres',   'Expertise et chiffres',        'Appel à des études, des économistes, des institutions', 7),
          ('registre', 'attaque_personnelle',  'Attaque personnelle',          'Vise une personne, pas la mesure', 8),
          ('registre', 'defiance',             'Défiance générale',            '« Tous les mêmes », « promesses jamais tenues »', 9),
          ('registre', 'comparaison_etrangere','Comparaison étrangère',        'Venezuela, Grèce, ou au contraire pays nordiques', 10)
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
              emetteur_profil AS "emetteurProfil", auteur_type AS "auteurType",
              auteur_affiliation AS "auteurAffiliation", erreur
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

  /** Met à jour une capture pendant sa consolidation. `traitee` date la fin du traitement. */
  async majCapture(
    id: string,
    m: { texte?: string; statut?: CaptureRow["statut"]; erreur?: string | null; auteurType?: string; auteurAffiliation?: string | null; traitee?: boolean },
  ): Promise<void> {
    await this.init();
    await this.pool.query(
      `UPDATE aec_captures SET
         texte = COALESCE($2, texte),
         statut = COALESCE($3, statut),
         erreur = CASE WHEN $4::boolean THEN $5 ELSE erreur END,
         auteur_type = COALESCE($6, auteur_type),
         auteur_affiliation = CASE WHEN $7::boolean THEN $8 ELSE auteur_affiliation END,
         traitee_le = CASE WHEN $9::boolean THEN now() ELSE traitee_le END
       WHERE id = $1`,
      [
        id, m.texte ?? null, m.statut ?? null, m.erreur !== undefined, m.erreur ?? null, m.auteurType ?? null,
        m.auteurAffiliation !== undefined, m.auteurAffiliation ?? null, m.traitee === true,
      ],
    );
  }

  /** Captures consolidées depuis minuit, heure de Paris : le plafond CONSOLIDATION_MAX_PER_DAY. */
  async consolideesAujourdhui(): Promise<number> {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS n FROM aec_captures
        WHERE traitee_le >= (date_trunc('day', now() AT TIME ZONE 'Europe/Paris') AT TIME ZONE 'Europe/Paris')`,
    );
    return rows[0].n as number;
  }

  /** Captures à consolider (plafond atteint, panne), les plus anciennes d'abord. */
  async capturesEnAttente(limit = 50): Promise<string[]> {
    await this.init();
    const { rows } = await this.pool.query(
      // Reçues, ou en erreur après une panne (pas un refus définitif comme un lien seul, daté traitee_le).
      `SELECT id FROM aec_captures
        WHERE statut = 'recue' OR (statut = 'erreur' AND traitee_le IS NULL)
        ORDER BY cree_le LIMIT $1`,
      [limit],
    );
    return rows.map((r) => r.id as string);
  }

  /**
   * Remplace les brouillons d'une capture par ceux d'une nouvelle consolidation (relance). Les
   * affirmations déjà validées ou rejetées par l'équipe ne sont jamais touchées.
   */
  async remplacerBrouillons(captureId: string, affirmations: NouvelleAffirmation[]): Promise<string[]> {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM aec_affirmations WHERE capture_id = $1 AND statut = 'brouillon'`, [captureId]);
      const ids: string[] = [];
      for (const a of affirmations) {
        const { rows } = await client.query(
          `INSERT INTO aec_affirmations
             (capture_id, texte, citation, types, position, theme, registre, force, publics, familles,
              passages_programme, verification_url, a_verifier, objection_proposee_id, propositions, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::vector)
           RETURNING id`,
          [
            captureId, a.texte, a.citation, a.types, a.position, a.theme, a.registre, JSON.stringify(a.force),
            JSON.stringify(a.publics), JSON.stringify(a.familles), JSON.stringify(a.passagesProgramme),
            a.verificationUrl, a.aVerifier, a.propositions[0]?.id ?? null, JSON.stringify(a.propositions),
            a.embedding ? vecteur(a.embedding) : null,
          ],
        );
        ids.push(rows[0].id as string);
      }
      await client.query("COMMIT");
      return ids;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  /** Les objections les plus proches (cosinus), au-dessus du seuil, avec le nombre d'affirmations rattachées. */
  async objectionsProches(embedding: number[], k = 3, min = 0): Promise<PropositionObjection[]> {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT o.id, o.intitule, 1 - (o.embedding <=> $1::vector) AS score,
              (SELECT count(*)::int FROM aec_affirmations a WHERE a.objection_id = o.id) AS rattachees
         FROM aec_objections o
        WHERE o.embedding IS NOT NULL AND 1 - (o.embedding <=> $1::vector) >= $3
        ORDER BY o.embedding <=> $1::vector
        LIMIT $2`,
      [vecteur(embedding), k, min],
    );
    return rows.map((r) => ({ id: r.id, intitule: r.intitule, score: Number(r.score), rattachees: r.rattachees }));
  }

  /**
   * La source de vérification d'un `debunk` déjà validé, proche de l'affirmation : elle peut
   * fonder l'étiquette `fake_news` (regles.ts). Sa propre URL, sinon celle de sa capture.
   */
  async verificationProche(embedding: number[], min: number): Promise<string | null> {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT COALESCE(a.verification_url, c.url) AS url
         FROM aec_affirmations a JOIN aec_captures c ON c.id = a.capture_id
        WHERE a.statut = 'validee' AND 'debunk' = ANY(a.types) AND a.embedding IS NOT NULL
          AND COALESCE(a.verification_url, c.url) IS NOT NULL
          AND 1 - (a.embedding <=> $1::vector) >= $2
        ORDER BY a.embedding <=> $1::vector
        LIMIT 1`,
      [vecteur(embedding), min],
    );
    return rows[0]?.url ?? null;
  }

  async affirmations(f: { statut?: "brouillon" | "validee" | "rejetee"; captureId?: string; limit?: number } = {}): Promise<AffirmationRow[]> {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT a.id, a.capture_id AS "captureId", a.texte, a.citation, a.types, a.position, a.theme, a.registre,
              a.force, a.publics, a.familles, a.passages_programme AS "passagesProgramme",
              a.verification_url AS "verificationUrl", a.a_verifier AS "aVerifier", a.propositions,
              a.statut, a.validee_par AS "valideePar", a.cree_le AS "creeLe"
         FROM aec_affirmations a
        WHERE ($1::text IS NULL OR a.statut = $1) AND ($2::uuid IS NULL OR a.capture_id = $2)
        ORDER BY a.cree_le DESC, a.id
        LIMIT $3`,
      [f.statut ?? null, f.captureId ?? null, f.limit ?? 50],
    );
    return rows;
  }

  /** Valide ou rejette une affirmation (préfixe d'identifiant accepté, s'il est unique). */
  async deciderAffirmation(idOuPrefixe: string, statut: "validee" | "rejetee", qui: string): Promise<AffirmationRow> {
    await this.init();
    const { rows } = await this.pool.query(
      `SELECT id FROM aec_affirmations WHERE id::text LIKE $1 || '%' LIMIT 2`,
      [idOuPrefixe.toLowerCase()],
    );
    if (rows.length === 0) throw new Error(`Aucune affirmation ${idOuPrefixe}`);
    if (rows.length > 1) throw new Error(`Identifiant ambigu : ${idOuPrefixe}`);
    const id = rows[0].id as string;
    await this.pool.query(
      `UPDATE aec_affirmations SET statut = $2, validee_par = $3, validee_le = now() WHERE id = $1`,
      [id, statut, qui],
    );
    await this.journaliser(qui, statut === "validee" ? "valider_affirmation" : "rejeter_affirmation", id);
    return (await this.affirmations({ limit: 1000 })).find((a) => a.id === id)!;
  }

  /** Une ligne dans aec_admin_log : qui a fait quoi, quand. */
  async journaliser(qui: string, action: string, objet?: string, detail?: string): Promise<void> {
    await this.init();
    await this.pool.query(`INSERT INTO aec_admin_log (who, action, doc_id, detail) VALUES ($1, $2, $3, $4)`, [
      qui, action, objet ?? null, detail ?? null,
    ]);
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

const vecteur = (v: number[]) => `[${v.join(",")}]`;

export interface PropositionObjection {
  id: string;
  intitule: string;
  score: number;
  rattachees: number;
}

export interface NouvelleAffirmation {
  texte: string;
  citation: string;
  types: string[];
  position: "pour" | "contre" | "neutre";
  theme: string | null;
  registre: string | null;
  force: Record<string, unknown>;
  publics: { code: string; justification: string }[];
  familles: { code: string; justification: string }[];
  passagesProgramme: unknown[];
  verificationUrl: string | null;
  aVerifier: boolean;
  propositions: PropositionObjection[];
  embedding: number[] | null;
}

export interface AffirmationRow {
  id: string;
  captureId: string;
  texte: string;
  citation: string;
  types: string[];
  position: "pour" | "contre" | "neutre" | null;
  theme: string | null;
  registre: string | null;
  force: Record<string, { note: number; justification: string }>;
  publics: { code: string; justification: string }[];
  familles: { code: string; justification: string }[];
  passagesProgramme: unknown[];
  verificationUrl: string | null;
  aVerifier: boolean;
  propositions: PropositionObjection[];
  statut: "brouillon" | "validee" | "rejetee";
  valideePar: string | null;
  creeLe: Date;
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
  auteurType: string | null;
  auteurAffiliation: string | null;
  erreur: string | null;
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
