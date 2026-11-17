# AECBot v2

Agent Mastra qui répond aux militants sur Telegram à partir du programme *L'Avenir en commun*
et de ses livrets, en citant chaque source avec sa page. Initiative non officielle, non endossée par LFI.

Sont faites les **étapes 1 à 3 de la feuille de route** : scan + index, agent + évals, bot Telegram.

| Étape | Contenu | État |
|---|---|---|
| 1 | Workflow `ingest` branché sur le WordPress, pgvector rempli | ✅ |
| 2 | Agent `aec`, outil de recherche filtré, réponse vérifiée, scorers, 40 questions types | ✅ |
| 3 | Bot Telegram (webhook, limite, mise en forme, mémoire 30 jours, /oublier) | ✅ |
| 4 | `/ajouter`, `/docs`, `/supprimer` pour l'équipe, et `pnpm docs` en ligne de commande | ✅ |
| Argu 1 | Argumentaire : tables, `POST /capture`, `/jeton`, catégorie `argumentaire` exclue du mode programme | ✅ |
| Argu 2–6 | Consolidation, interface `/admin`, `/capter`, extension, collectes automatiques | à venir |

## Démarrer en local

Prérequis : Node ≥ 22.13, pnpm (`corepack enable`), Docker.

```bash
pnpm install
cp .env.example .env          # renseigner MISTRAL_API_KEY ou OPENROUTER_API_KEY
pnpm db:up                    # Postgres 17 + pgvector
pnpm ingest --limit 3         # essai sur 3 documents
pnpm ingest                   # scan complet
pnpm ask "Que dit le programme sur la retraite ?"
pnpm evals                    # les 40 questions types, grille de décision (base et clés de .env)
pnpm evals:prod               # idem contre l'index de production (.env.production)
pnpm evals:recherche          # la recherche seule, sans LLM : recall@k et MRR
pnpm bot                      # le bot en local (long polling), avec TELEGRAM_BOT_TOKEN
pnpm dev                      # Mastra Studio sur http://localhost:4111
```

Pour `pnpm bot`, remplir aussi `PSEUDONYM_SECRET` (32 caractères au moins, par exemple
`openssl rand -hex 32`). Ne pas le lancer contre le bot de production : il supprime le webhook.

Dans Studio, le workflow `ingest` montre chaque étape et chaque document traité.

## Clés de modèles : Mistral ou OpenRouter

Une seule clé suffit :

- `MISTRAL_API_KEY` : Mistral en direct, traitement dans l'UE. Préférée si les deux sont présentes.
- `OPENROUTER_API_KEY` : les mêmes modèles Mistral via OpenRouter (`mistralai/mistral-embed-2312`
  pour les embeddings, `openrouter/mistralai/mistral-small-2603` pour répondre,
  `openrouter/mistralai/mistral-medium-3-5` pour le juge). Les vecteurs sont ceux de
  `mistral-embed` dans les deux cas : on peut passer de l'un à l'autre sans réindexer.

Via OpenRouter, les questions transitent par un intermédiaire de plus. OpenRouter ne garde pas
les prompts par défaut ; le routage limité à l'Europe est réservé à ses offres Business et
Enterprise. À trancher avant d'ouvrir le bot au-delà d'un groupe test.

## Le programme : le livre 2026 (EPUB), seule version qui fait foi

Le programme général est **le livre *L'Avenir en commun*** (cinquième édition, 2025-2027, EPUB
daté de novembre 2026). Les anciennes versions ne sont plus interrogées : le PDF « PROGRAMME SITE
2025 » du WordPress est écarté au classement (`ANCIEN_PROGRAMME` dans `src/corpus/classify.ts`), et
la version abrégée 2022 a été retirée de `src/corpus/sources.ts`. Les livrets et les plans restent
valables, y compris ceux de 2022.

```bash
pnpm docs:prod livre ~/Téléchargements/LAvenir_en_commun.epub
```

- **Pas de lien public, pas de texte dans le dépôt** : le dépôt GitHub est public, le livre n'y est
  donc pas versionné. La commande lit l'EPUB sur ton poste et l'indexe directement dans la base.
  Relancer la commande avec une nouvelle version remplace l'ancienne (identifiant fixe
  `manual:livre-aec`). Le scan WordPress ne le touche pas.
- **Une section = une « page »** : `src/corpus/epub.ts` lit l'EPUB (zip lu sans dépendance) et
  fait une entrée par section (« Garantir une retraite digne »), plus l'introduction et les
  ouvertures de partie. Chaque passage porte `section` (« Partie 3 : … › Chapitre 1 : … › Garantir
  une retraite digne ») ; `page` est le rang de la section, utilisé seulement en interne (regroupement,
  élargissement à la section entière). Une section de plus de 5 000 caractères (l'introduction) est
  coupée entre deux paragraphes.
- **Citation** : « [1] L'Avenir en commun (livre, édition 2026), « Garantir une retraite digne » »,
  sans page ni lien. Le livre est rangé en `programme`, édition `aec2027`, non provisoire : plus
  d'avertissement « programme provisoire ».
- Au déploiement, le scan suivant retire de lui-même les passages du PDF 2025 déjà indexés (un
  document inclus que les règles excluent désormais est retraité, sans `--force`) ; la version
  abrégée 2022 disparaît de la même façon, comme un document retiré du site.

### Livrets et plans de 2022

Les livrets et plans de la campagne 2022 (Union populaire, `Livret_UP_…`, `Plan_UP_…`, livrets
Éducation et ESR), re-téléversés en 2024 sur le WordPress actuel, sont rangés en `aec2022`
(`isEdition2022` dans `src/corpus/classify.ts`). Restent dans l'édition actuelle : le livre, les
publications 2026, les pages du site et le plan Europe (non identifié comme 2022). Après un
changement de classement, `pnpm ingest --force` réindexe tout.

- `EDITIONS=aec2027,aec2022` (défaut) : la recherche porte sur les deux éditions.
- L'agent doit dire dans sa phrase qu'une information vient d'un document 2022, pas à jour, et
  préférer une source plus récente en cas d'écart. La réponse ajoute un avertissement et la source
  porte la mention « version 2022, pas à jour ».

## Le workflow `ingest`

Deux portes d'entrée, un seul workflow :

- `{ "mode": "scan" }` : le scan WordPress (planifié chaque nuit par `INGEST_CRON`, heure de Paris).
- `{ "mode": "manuel", "title", "url" | "text", "addedBy", "telegramFileId"? }` : un ajout de l'équipe.

```
detecter ─▶ foreach(document) ─▶ resumer
              └─ recuperer ▶ classer ▶ decouper ▶ indexer
```

1. **Détecter** : compare l'API WordPress (`/wp-json/wp/v2/media` en PDF, pages et articles sous
   `/programme/`) au registre `aec_documents` sur l'id et la date de modification. Les documents
   disparus du site sont retirés, sauf si plus de 20 % disparaissent d'un coup (panne probable :
   relancer avec `--allow-mass-removal` si c'est voulu).
2. **Récupérer** : PDF → texte page par page (unpdf) ; HTML → Markdown (turndown). Un échec de
   téléchargement n'arrête pas le scan : le document est retenté la nuit suivante.
3. **Classer** : `programme` (le livre seulement), `livret`, `plan`, `publication_2026`, `page`,
   `ajout_manuel`. Sont écartés : anciennes versions du programme (PDF 2025, Synthèse des contributions
   de juillet 2026 sous `/programme/synthese-des-contributions/`), comparateurs avec d'autres partis
   (titre « Comparateur… » ou adresse `/comparateur-…`), archives NFP 2024, dossiers de presse et
   documents non classés (sans même être téléchargés),
   PDF sans texte exploitable, doublons exacts (le plus récent est gardé). Les règles reproduisent
   les 75 décisions de l'ancien pipeline (`tests/classify.test.ts`).
4. **Découper** : `MDocument`, un découpage par page pour garder `page` en métadonnée.
5. **Indexer** : embeddings `mistral-embed` (1024 dim., Mistral ou OpenRouter) → upsert dans l'index
   pgvector `aec_passages`, en remplaçant tous les anciens passages du document.

Chaque passage porte : `docId`, `title`, `url`, `page`, `section` (livre EPUB), `category`, `corpus` (`aec2027`),
`origin`, `modified`, `provisional`, `text`.
Les documents écartés restent dans le registre avec leur raison, pour ne pas être retéléchargés.

## Répondre : agent `aec` + vérification

```
question ─▶ agent aec ──▶ outil recherche (pgvector, édition 2027 par défaut) ──▶ passages P1, P2…
                 └──▶ texte avec [P1][P3] ──▶ verifyAnswer ──▶ { statut, texte [1][2], sources, avertissements, controle }
```

`repondre(question)` (`src/aec/repondre.ts`) est le point d'entrée du bot et des évals.

- **Outil `recherche`** : recherche **hybride** filtrée sur `corpus` (`aec2027`, ou `aec2022` si la
  question le demande). Dans chaque édition, la recherche vectorielle (`mistral-embed`) et une recherche
  plein texte Postgres en français (`src/corpus/fulltext.ts`, index GIN créé au démarrage de l'ingestion)
  se combinent : tous les passages trouvés par le sens sont gardés, et le plein texte en **ajoute** au
  plus 3 par édition, le tout ordonné par fusion des rangs (RRF). Il ne peut donc pas faire perdre un
  passage trouvé par le sens (« cryptomonnaies » ne partage aucun mot avec « crypto-actifs »). Le plein
  texte ne garde que les mots qui distinguent (ni mots vides, ni « programme », « prévoit »…) : un mot
  cité une seule fois dans une liste (« corrida ») remonte son passage. `score` reste la similarité
  cosinus. L'agent reçoit donc jusqu'à 16 passages au lieu de 10. Le modèle voit des passages numérotés
  P1, P2… avec titre, page et type de document, sans URL. Tous les passages renvoyés sont
  gardés dans un collecteur propre à la question.
- **Vérification** (`src/aec/verify.ts`) : une référence que l'outil n'a pas renvoyée est
  rejetée ; une phrase dont toutes les références sont rejetées est retirée ; les références
  deviennent [1], [2]… (une par document et page) avec la liste des sources. Sans aucune
  citation valide, y compris quand le modèle répond de mémoire sans chercher, la réponse
  devient « introuvable ». Le modèle ne rédige jamais la liste des sources : elle vient des
  métadonnées.
- **Réponse partielle contrôlée** (`src/aec/objet.ts`) : quand l'agent commence par « Je ne trouve
  pas de passage qui réponde précisément… », un appel court (`AEC_CHECK_MODEL`, par défaut le modèle
  du juge) vérifie qu'un passage cité traite de l'objet précis de la question, pas seulement du même
  thème. Sinon la réponse devient « introuvable ». Le verdict est dans `controle.objet` (traces,
  évals). En cas de panne du contrôle, la réponse, déjà vérifiée citation par citation, est gardée.
- **Sortie** : le modèle écrit du texte avec des références, que la vérification transforme en
  objet. Une sortie JSON native aurait demandé une seconde passe de structuration (coût d'entrée
  doublé) ou risqué que le modèle réponde sans appeler l'outil.

## Évals : la grille de décision

`evals/questions.json` : 17 questions dont la réponse est dans le corpus (sources et pages
attendues relevées dans le corpus actuel ; pour le livre, les titres de section attendus), dont 1 sur un livret 2022 et 1 à laquelle les textes
ne répondent qu'en partie (démission et Constituante), 3 hors corpus et 1 tentative de détournement.

S'y ajoutent 19 questions `objection-*` : les critiques adressées au programme et au candidat,
telles qu'un militant les entend. 15 portent sur le programme (chiffrage, dette, fiscalité,
police, retraite, nucléaire, Ukraine, OTAN, Israël, antisémitisme) et attendent une réponse
sourcée. Leurs sources viennent surtout de la publication d'octobre 2026 sur les comptes publics
et des plans et livrets. Pour le livre, les titres de section ne sont donnés que là où ils sont
déjà connus, sinon le document seul. 4 visent la personne ou la campagne (antisémitisme de
Mélenchon, Jeune Garde, second tour, primaire) : le programme n'y répond pas, l'agent doit
répondre « introuvable » sans improviser.

```bash
pnpm evals --model mistral/mistral-small-latest --model openai/gpt-5-mini
```

| Critère | Scorer | Seuil |
|---|---|---|
| Citations | `citations-valides` : citations du modèle qui renvoient à un passage récupéré | 0 rejetée |
| Hors corpus | `statut-attendu` sur les questions sans réponse | 100 % « introuvable » |
| Fidélité | `fidelite` : juge LLM (`AEC_JUDGE_MODEL`), affirmations soutenues par les passages cités | ≥ 0,9 |
| Coût | jetons mesurés × `evals/prix.json` | le moins cher qui passe |

S'y ajoutent, à titre indicatif, la part de bons statuts et la part de questions où une source
attendue est citée. Renseigner les prix Mistral dans `evals/prix.json` avant de comparer.
`--sans-juge` évite les appels au juge ; `--only <id>` restreint aux questions choisies.
Le détail de chaque passe est écrit dans `evals/resultats/`.

Chaque passe est aussi enregistrée comme **experiment Mastra** : `evals/questions.json` est
synchronisé vers le dataset « Questions types » (versionné en base : ajout, modification, retrait),
puis chaque modèle donne un experiment avec réponses, scores et traces par question. Dans Studio
(`pnpm dev` → Datasets → Questions types → Experiments), on relit les réponses et **Compare**
met plusieurs passes côte à côte. Avec plusieurs `--model`, le script liste aussi les questions
où les modèles diffèrent du premier. Les questions passent 3 par 3 (`--concurrence N` pour changer) ;
`--local` (ou `--only`) revient à une passe non enregistrée. Le code est dans `src/aec/experiments.ts`.


### Éval de la recherche seule

```bash
pnpm evals:recherche                 # réglages de l'outil : top 10, toutes éditions
pnpm evals:recherche --only smic     # détail des 5 premiers résultats
```

Sans LLM, avec un embedding par question : la recherche remonte-t-elle une des sources
attendues de `evals/questions.json`, et à quel rang ? On obtient le **recall@k** (part des
questions dont une source attendue figure dans les k premières pages), le **MRR** (moyenne de
1/rang) et la **couverture** (part des sources attendues trouvées). Ce sont les chiffres à
comparer avant et après un changement de découpage, de quotas, de recherche hybride ou de
reranking. Le script affiche aussi le meilleur score des questions avec réponse et des questions
hors corpus, pour savoir si un seuil de score les séparerait. La requête est la question brute :
l'agent, lui, la reformule en mots-clés, donc ces chiffres sont plutôt un plancher.

## Le bot Telegram

```
Telegram ─▶ POST /telegram (secret vérifié) ─▶ grammY ─▶ limite/heure ─▶ repondre(question, historique) ─▶ message HTML
```

- **Messages privés uniquement** ; les groupes sont ignorés. Commandes : `/start`, `/aide`, `/oublier`.
- **Pseudonymisation** : l'identifiant Telegram devient `u_…` (HMAC-SHA256 avec `PSEUDONYM_SECRET`)
  dès l'entrée. Il n'est ni stocké, ni journalisé, ni transmis à l'agent. Les journaux ne
  contiennent ni question ni réponse : statut, compteurs de vérification, jetons, durée.
- **Limite** : `RATE_LIMIT_PER_HOUR` questions par personne et par heure, compteur atomique en
  base (fonctionne avec plusieurs instances serverless).
- **Mémoire** : les 3 derniers échanges des dernières 24 h servent aux questions de suite. Tout
  est effacé au bout de `MEMORY_DAYS` jours par le workflow `purge` (`PURGE_CRON`), ou tout de
  suite avec `/oublier`.
- **Mise en forme** : texte échappé, sources cliquables qui ouvrent le PDF à la bonne page
  (`#page=N`), titres lisibles (« Livret « santé » » plutôt que `Livret_UP_13_SANTE_web-ok`),
  avertissement « programme provisoire » si besoin, mention « initiative non officielle » sur
  chaque réponse, aperçus de liens désactivés.

### Ajouter des documents sans passer par WordPress

Pour l'équipe (identifiants Telegram dans `TEAM_TELEGRAM_IDS`, séparés par des virgules ; un
membre trouve le sien avec @userinfobot), en message privé au bot :

| Commande | Effet |
|---|---|
| PDF envoyé avec la légende `/ajouter Titre` | télécharge le PDF (20 Mo max), l'indexe page par page |
| `/ajouter https://… Titre` | télécharge le PDF ou la page web du lien |
| `/ajouter Titre` puis le texte sur les lignes suivantes | indexe le texte |
| `/docs` | liste les documents ajoutés, avec leur identifiant court |
| `/supprimer identifiant` | retire le document et tous ses passages |

Un EPUB passé à `pnpm docs ajouter --fichier livre.epub` est aussi lu section par section. Pour le
livre du programme, utiliser `pnpm docs:prod livre fichier.epub` (voir plus haut).

Les autres utilisateurs reçoivent « commande réservée à l'équipe ». Même chose depuis le terminal :

```bash
pnpm docs:prod liste
pnpm docs:prod ajouter --titre "Note sur les retraites" --fichier note.pdf
pnpm docs:prod ajouter --titre "Tribune" --url https://exemple.fr/tribune
pnpm docs:prod supprimer 3f2a9c1b
pnpm docs:prod livre LAvenir_en_commun.epub     # le livre du programme
```

Tout passe par le workflow `ingest` (mode `manuel`) : mêmes contrôles que le scan (PDF sans
texte exploitable refusé, doublon exact écarté), catégorie `ajout_manuel`, utilisable tout de
suite et **sans relecture**. Un document ajouté sans lien public est cité « (document de
l'équipe) », sans lien. Seuls les documents ajoutés à la main peuvent être supprimés ainsi (un
document WordPress reviendrait au scan suivant). Chaque ajout et suppression est journalisé dans
`aec_admin_log` (qui, quoi, quand).

### Avis des militants (👍/👎)

Sous chaque réponse, deux boutons. Après un 👎, le bot demande « Qu'est-ce qui n'allait pas ? » ;
la réponse à ce message est enregistrée comme commentaire (elle ne compte pas comme une question).

- Chaque réponse est **tracée** par l'observabilité Mastra (question, recherches, passages reçus,
  réponse), et le vote s'attache à cette trace : `feedbackType` `thumbs` (1 / -1) ou `comment`,
  `feedbackUserId` = pseudonyme. Seules les réponses passant par `repondre()` sont tracées.
- Les traces sont stockées dans la base Neon (UE) : `PostgresStoreVNext`, la variante dont
  l'observabilité gère le feedback. Elles suivent la même règle que la mémoire : `MEMORY_DAYS` jours
  (purge nocturne via `storage.prune()`), effacées par `/oublier`.
- Sur Mastra Platform, `@mastra/observability` retire sans prévenir tout `MastraStorageExporter`
  (les traces n'iraient qu'à Mastra Cloud). On passe donc par `NeonStorageExporter`
  (`src/mastra/storage-exporter.ts`), qui l'enveloppe. `GET /status` renvoie `"traces": true`
  quand l'exporteur vers Neon est actif, et 503 « traces non enregistrées » sinon ; la CI lance le
  build avec `MASTRA_DEPLOYMENT_ID` pour le vérifier avant chaque déploiement.
- Un vote n'est accepté que si la réponse a bien été donnée à cette personne.
- **Copie vers Mastra Cloud** : avec `MASTRA_PLATFORM_ACCESS_TOKEN` et `MASTRA_PROJECT_ID` dans les
  variables de production, traces, votes et commentaires partent aussi vers le tableau de bord
  Mastra Cloud (Observability), en plus de Neon. Cette copie suit la conservation de Mastra Cloud :
  ni la purge nocturne ni `/oublier` ne l'effacent. Sans token, rien ne part.
- **Relire les votes depuis ton poste** : `pnpm feedback:prod` (toute la période, regroupés par
  réponse, avec la question et la réponse encore en mémoire) ; `--negatifs` pour ne garder que
  les 👎 et commentaires, `--jours 7` pour réduire la période, `--complet` pour les réponses entières.
- **Lire les avis** : Mastra Cloud → Observability, ou Studio → Observability → Traces, onglet Feedback de chaque trace, ou l'API
  `GET /api/observability/feedback?feedbackType=thumbs` (avec `ADMIN_API_TOKEN`). Les bons cas
  de 👎 vont dans `evals/questions.json`.

Les boutons utilisent les `callback_query` de Telegram : après le déploiement, relancer
`pnpm webhook:prod <URL>` une fois pour que le webhook les reçoive.

### Suites numérotées (« Pour aller plus loin »)

Après une réponse trouvée, l'agent ajoute un bloc `SUITES :` de 3 questions de suite au plus. Chacune
porte sur un point qu'un passage reçu traite et cite ce passage (`… ? [P4]`). `parseSuites()`
(src/aec/verify.ts) les sépare du texte vérifié : seules de vraies questions courtes (« ? », 120
caractères au plus) sont gardées, et **seulement si elles citent un passage que la recherche a renvoyé**
(sinon `controle.suitesSansPassage`). La référence n'est pas affichée.

- Affichées sous les sources, numérotées, avec un bouton par suite (`sx:<n>:<traceId>`) sous 👍/👎.
- Toucher un bouton, ou envoyer « 2 » au clavier, pose la question proposée ; elle est rappelée en
  tête de la réponse (🔎) et compte comme une question (limite horaire).
- Les suites sont stockées avec la réponse (`aec_conversations.suites`) et relues en base : un bouton
  forgé ne peut pas faire poser une autre question. Après un vote, les boutons des suites restent.
- **Seulement des suites qu'on sait servir** : chaque suite est cherchée dans l'index avant d'être
  affichée (un seul appel d'embeddings pour toutes, `src/aec/suites.ts`). Elle n'est gardée que si
  son meilleur passage atteint `SUITES_MIN_SCORE` (0,8 par défaut). En cas de panne : aucune suite.
- **Jeu de données** : `pnpm suites:donnees:prod` construit `evals/suites.json` (suites réelles avant
  filtre, questions écrites depuis des passages, questions voisines sans réponse), étiqueté par un juge
  LLM ; les désaccords sont marqués `aRelire`, à trancher à la main.
- **Calibrer le seuil** : `pnpm suites:calibrer:prod` score ce jeu et affiche, par seuil, les
  introuvables proposées à tort et les bonnes suites retirées ; `pnpm suites:calibrer:prod "question"`
  teste une question. Premier calibrage (209 questions) : le score seul ne sépare pas les groupes,
  d'où l'exigence d'un passage cité. En production, le journal « question traitée » donne `origine: "suite"`,
  `suitesProposees` et `suitesRetirees` : une suite choisie qui finit introuvable = seuil trop bas.
- Coût : quelques dizaines de jetons de sortie et un appel d'embeddings par réponse.

### Avis généraux sur le bot (`/avis`) et réponses de l'équipe

`/avis` (ou `/avis texte`) envoie un avis sur le bot en général, sans lien avec une réponse.

- Stocké dans `aec_avis` (pseudonyme, texte, date), purgé après `MEMORY_DAYS` jours, effacé par
  `/oublier`. Ne compte pas comme une question. 5 avis au plus par personne et par 24 h.
- Chaque membre de `TEAM_TELEGRAM_IDS` reçoit l'avis sur Telegram (« Avis n° 12 », pseudonyme tronqué,
  jamais le nom). Il faut avoir écrit au bot une fois pour recevoir ses messages.
- **Répondre** : répondre (glisser / « Répondre ») à la notification, ou `/repondre 12 texte`. La
  personne reçoit « Réponse de l'équipe » et peut y répondre à son tour : sa réponse redevient un avis.
- Pour pouvoir répondre, l'identifiant de discussion est gardé **chiffré** (AES-256-GCM, clé dérivée
  de `PSEUDONYM_SECRET`) avec l'avis seulement, et disparaît avec lui.
- `pnpm avis:prod [--jours 7]` liste les avis.

Après le déploiement, `pnpm webhook:prod <URL>` met à jour le menu des commandes (ajoute `/avis`).

### Brancher le bot en production

1. Renseigner `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `PSEUDONYM_SECRET` et
   `ADMIN_API_TOKEN` dans les secrets du déploiement.
2. `pnpm webhook https://<serveur-déployé>` : branche le webhook sur `/telegram` avec le secret
   et déclare les commandes. `pnpm webhook --info` affiche son état.

`ADMIN_API_TOKEN` protège toutes les routes `/api/*` (Studio, agents, workflows) : sans lui,
n'importe qui pourrait appeler l'agent à vos frais ou lancer un ajout manuel. `/telegram` reste
public, protégé par le secret du webhook.

## Argumentaire : captures

Première étape de la spec « collecte et consolidation d'argumentaires » : le socle sur lequel
viendront la consolidation, l'interface de validation et les canaux de capture.

- **Tables** (`src/argu/store.ts`, créées au premier usage) : `aec_captures` (contenu brut, gardé
  sans limite : ni `purge` ni `MEMORY_DAYS` ne s'y appliquent), `aec_affirmations`,
  `aec_objections`, `aec_referentiels` et `aec_jetons`. Référentiels livrés au départ, modifiables
  ensuite (une entrée renommée ou désactivée n'est jamais écrasée) :
  - catégories : `argument`, `critique`, `objection`, `debunk`, `fake_news` ;
  - classes sociales (sur le modèle des catégories de l'Insee) : ouvrier, employé, profession
    intermédiaire, cadre, artisan ou commerçant, chef d'entreprise, agriculteur, retraité, étudiant,
    sans emploi ;
  - familles politiques : extrême gauche, gauche radicale, écologistes, sociaux-libéraux, centre,
    droite libérale, droite conservatrice, extrême droite, puis, hors de l'axe gauche-droite,
    souverainistes et libertariens ;
  - publics (à qui parle l'argument) : quartiers populaires, rural et périurbain, jeunes,
    retraités, salariés modestes, classes moyennes salariées, fonctionnaires, indépendants et petits
    patrons, agriculteurs, abstentionnistes et déçus ;
  - thèmes, alignés sur les chapitres du programme (salaires, retraites, fiscalité, dette, services
    publics, logement, écologie, énergie, institutions, sécurité, immigration, Europe, travail,
    agriculture) ;
  - registres : coût et faisabilité, pouvoir d'achat, peur, valeurs, identité, sécurité, expertise
    et chiffres, attaque personnelle, défiance générale, comparaison étrangère.

  `indetermine` n'est pas une entrée : c'est la valeur par défaut d'un trait de l'émetteur.
- **`/jeton`** (équipe seulement, en privé) : donne un jeton personnel pour l'extension, montré une
  seule fois ; seule son empreinte SHA-256 est stockée, avec le pseudonyme. Un nouveau `/jeton`
  invalide le précédent ; `/jeton revoquer` l'invalide sans le remplacer.
- **`POST /capture`** : route publique comme `/telegram`, protégée par ce jeton
  (`Authorization: Bearer …`). 201 à la première réception, 200 avec le même `id` pour un doublon
  (même URL normalisée, même texte aux espaces près), 401, 413 (texte de plus de 50 000
  caractères), 422 (avec le champ en cause), 429 (plus de `CAPTURE_MAX_PER_TOKEN` captures en 24 h).
  `GET /capture/config` renvoie les sélecteurs DOM de X et YouTube (`src/argu/selecteurs.ts`).
- **Émetteur et argument** : la consolidation (étape 2) analysera à la fois l'argument (à quels
  publics il parle) et son émetteur (classe sociale, orientation politique), **particuliers
  compris**. Le profil de l'émetteur est rangé dans `aec_captures.emetteur_profil`, avec pour
  chaque trait sa justification, l'extrait de la capture qui la fonde et son origine
  (`declare`, `deduit`, `corrige`). Garde-fous prévus : sans extrait retrouvé mot pour mot dans la
  capture, le trait vaut `indetermine` (jamais de déduction sur le seul nom) ; une appartenance
  déclarée prime ; la correction de l'équipe fait foi ; le profil n'est jamais indexé, jamais montré
  aux militants ni journalisé, et il est effacé avec les captures de l'auteur.

  > ⚠️ **Risque juridique.** Une orientation politique attribuée à une personne identifiable est
  > une donnée sensible au sens du RGPD (article 9), et les captures sont gardées sans limite. Ces
  > mesures réduisent le risque sans valoir analyse juridique : **un avis juridique est recommandé
  > avant la mise en service de la déduction pour les particuliers.**
- **Mode programme protégé** : la catégorie `argumentaire` est exclue par défaut de
  `searchPassages`, et l'outil `recherche` de l'agent `aec` l'exclut explicitement. Un test
  d'intégration vérifie qu'une fiche indexée ne remonte jamais.

```bash
curl -X POST https://<serveur>/capture -H "Authorization: Bearer aec_…" -H 'content-type: application/json' \
  -d '{"source_type":"x","url":"https://x.com/compte/status/123","texte":"Texte complet du post"}'
```

## Tests

```bash
pnpm test                                   # unitaires (agent testé avec un modèle simulé)
pnpm db:up && pnpm db:test                  # crée la base aecbot_test (une fois ; « already exists » ensuite)
TEST_DATABASE_URL=postgresql://aecbot:aecbot@localhost:5432/aecbot_test pnpm test
                                            # + intégration sur Postgres réel (site et Mistral simulés)
```

Les tests d'intégration suppriment leurs tables : ils n'utilisent que `TEST_DATABASE_URL`, jamais
la base de `.env`.

## Déploiement : GitHub Actions → Mastra Platform

`.github/workflows/ci.yml` tourne sur chaque PR et chaque push :

1. **verifier** : `pnpm install --frozen-lockfile`, typecheck, tests unitaires et d'intégration
   (service Postgres `pgvector/pgvector:0.8.1-pg17`), `mastra build`.
2. **deployer** (push sur `main` uniquement, et seulement si *verifier* passe) :
   `mastra deploy --env production --region eu --workers in-process --yes`, puis attend que
   `GET /status` renvoie le commit déployé (si la variable `PROD_URL` est définie).

`.github/workflows/evals.yml` se lance à la main (onglet Actions) : les 40 questions types
contre l'index de production, résultat dans le résumé du job et en artefact.

Les secrets de l'application restent côté Mastra ; GitHub ne connaît que de quoi déployer.
Ne pas installer en plus l'app GitHub de Mastra (auto-deploy) : chaque push partirait deux fois,
et sans attendre les tests.

### Mise en place (une fois)

1. **Repo GitHub** : créer un repo privé (par exemple `aecbot-v2`), puis dans le dossier :
   `git init`, `git add .`, `git commit -m "AECBot v2"`, `git branch -M main`,
   `git remote add origin <url>`, `git push -u origin main`. Le premier push lance la CI ;
   le déploiement échoue tant que l'étape 4 n'est pas faite, c'est normal.
2. **Base de production** : un projet [Neon](https://neon.com) en région UE (Francfort), avec
   l'extension `vector` (créée automatiquement au premier démarrage). Garder son `DATABASE_URL`.
3. **Projet Mastra**, depuis ton poste :
   ```
   pnpm exec mastra auth login
   pnpm exec mastra deploy --env production --region eu --workers in-process
   ```
   Ce premier déploiement crée le projet et `.mastra-project.json` : **commiter ce fichier**.
   Puis, dans le tableau de bord Mastra → Environments → production → Variables, renseigner :
   `DATABASE_URL`, `OPENROUTER_API_KEY` (ou `MISTRAL_API_KEY`), `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_WEBHOOK_SECRET`, `PSEUDONYM_SECRET` (une nouvelle clé, propre à la production),
   `ADMIN_API_TOKEN`, `INGEST_CRON=0 3 * * *`, `PURGE_CRON=30 3 * * *`, `EDITIONS`,
   `TEAM_TELEGRAM_IDS`. Pour voir traces et votes dans Mastra Cloud : `MASTRA_PLATFORM_ACCESS_TOKEN`
   (`pnpm exec mastra auth tokens create observability`) et `MASTRA_PROJECT_ID` (dans `.mastra-project.json`).
   Activer l'option **Persistent Server** : sans elle le serveur peut s'endormir, et les scans
   et purges planifiés ne sont pas garantis.
4. **Secrets GitHub** : Settings → Environments → créer `production`, puis y ajouter
   `MASTRA_API_TOKEN` (créé par `pnpm exec mastra auth tokens create ci-deploy`, affiché une seule
   fois), `MASTRA_ORG_ID` et `MASTRA_PROJECT_ID` (dans `.mastra-project.json` ou le tableau de bord),
   et la variable `PROD_URL` (l'URL du serveur, par exemple `https://<projet>.server.mastra.cloud`).
   Option : exiger une approbation manuelle avant chaque mise en production (« Required reviewers »).
   Pour les évals : `EVALS_DATABASE_URL` (la base Neon) et `OPENROUTER_API_KEY`.
5. **Premier remplissage de l'index** : depuis ton poste, avec `DATABASE_URL` de Neon :
   `pnpm ingest`. Ensuite le scan de nuit prend le relais.
6. **Webhook Telegram**, une fois : `pnpm webhook <PROD_URL>` avec le token et le secret de
   production dans `.env`. Ne plus lancer `pnpm bot` avec le token de production ensuite (il
   supprime le webhook) : créer un second bot via @BotFather pour les essais en local.

### En cas de panne de Mastra : avis de maintenance

Quand le serveur Mastra ne répond plus, Telegram envoie les messages dans le vide et les
utilisateurs n'ont aucune réponse. `maintenance/` est un Cloudflare Worker de secours qui répond
à chaque message privé (et à chaque bouton 👍/👎) par un avis de panne. Il répond au webhook par
un appel de méthode dans le corps HTTP : il n'a pas besoin du token du bot, seulement du secret
du webhook pour refuser les requêtes qui ne viennent pas de Telegram.

Bascule depuis l'onglet Actions (ou l'appli GitHub sur téléphone) → **Maintenance du bot** :
- `activer` : déploie le Worker, vérifie qu'il répond, branche le webhook dessus et met
  « ⚠️ Service momentanément indisponible » dans la description courte du bot ;
- `desactiver` : vérifie que `PROD_URL/status` répond, rebranche le webhook sur Mastra et vide la
  description. Les messages reçus pendant la panne ont eu l'avis, ils ne sont pas rejoués.

Mise en place, une fois : un compte Cloudflare (gratuit), un jeton d'API créé avec le modèle
« Edit Cloudflare Workers », puis dans l'environnement GitHub `production` les secrets
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `TELEGRAM_BOT_TOKEN` et
`TELEGRAM_WEBHOOK_SECRET` (les mêmes valeurs que côté Mastra). C'est la seule exception à
« les secrets de l'application restent côté Mastra » : sans eux, impossible de basculer quand
Mastra est en panne.

## Arborescence

```
src/
├─ config.ts                 variables d'environnement
├─ aec/                      répondre à une question
│  ├─ search.ts              recherche pgvector filtrée
│  ├─ collector.ts           passages vus par l'agent (P1, P2…)
│  ├─ verify.ts              vérification des citations
│  ├─ repondre.ts            point d'entrée : agent + vérification
│  └─ evals.ts               passe des questions types, grille
├─ corpus/                   logique d'ingestion, testable sans Mastra
│  ├─ wordpress.ts           client API WordPress
│  ├─ manual.ts              ajouts et suppressions par l'équipe
│  ├─ extract.ts             PDF et HTML → texte
│  ├─ epub.ts                EPUB (livre du programme) → sections
│  ├─ classify.ts            catégories, doublons, extraction vide
│  ├─ chunk.ts               découpage par page
│  ├─ embed.ts               embeddings (Mistral ou OpenRouter)
│  ├─ store.ts               registre aec_documents + index pgvector
│  └─ deps.ts                assemblage (remplaçable en test)
├─ argu/                     argumentaire : captures, jetons, tables
│  ├─ capture.ts             enregistrerCapture() : validation, dédoublonnage
│  ├─ jetons.ts              jetons de l'extension (empreinte seule)
│  └─ store.ts               tables aec_captures, aec_affirmations…
├─ telegram/                 le bot
│  ├─ bot.ts                 commandes, questions, limite
│  ├─ format.ts              message HTML, titres lisibles
│  ├─ privacy.ts             pseudonymisation
│  ├─ store.ts               compteurs et mémoire en base
│  └─ runtime.ts             bot depuis l'environnement, webhook
└─ mastra/
   ├─ index.ts               instance Mastra
   ├─ agents/aec.ts          instructions, modèle
   ├─ routes/capture.ts      POST /capture, GET /capture/config
   ├─ tools/recherche.ts     outil de recherche
   ├─ scorers/index.ts       citations, statut, source attendue, fidélité
   └─ workflows/             ingest, purge
scripts/                     ingest, ask, evals, bot, webhook, corpus, docs, feedback
.github/workflows/           ci.yml (tests + déploiement), evals.yml (à la demande),
                             maintenance.yml (bascule vers l'avis de panne)
maintenance/                 Cloudflare Worker de secours (avis de panne)
evals/                       questions types, prix
tests/
```
