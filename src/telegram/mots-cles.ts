/**
 * Nuage des mots-clés les plus demandés : calcul pur, sans base, à partir des questions posées.
 *
 * Confidentialité : seuls des comptes agrégés sortent d'ici, jamais une question. Un mot n'est
 * gardé que s'il a été employé par au moins `minPersonnes` personnes distinctes, pour qu'un terme
 * propre à une seule personne (un nom, une ville) ne ressorte pas.
 */

export interface QuestionPosee {
  pseudo: string;
  content: string;
}

export interface MotCle {
  /** Forme la plus fréquente du mot, telle qu'écrite (accents compris). */
  mot: string;
  /** Nombre de questions qui le contiennent (une fois par question). */
  questions: number;
  /** Nombre de personnes distinctes qui l'ont employé. */
  personnes: number;
  /** Entre 0 et 1, relatif au mot le plus demandé : la taille dans le nuage. */
  poids: number;
}

export interface OptionsMotsCles {
  limite?: number;
  minPersonnes?: number;
}

/** Mots vides du français, mots interrogatifs et formules qui reviennent dans toutes les questions. */
const MOTS_VIDES = new Set(
  `
  a ai aie aient aies ait as au aucun aucune aupres aussi autre autres aux avais avait avant avec avez avoir avons
  bah beaucoup bien bon bref ca car ce ceci cela celle celles celui cependant certain certaine certains ces cet cette
  ceux chaque chez ci comme comment concernant contre combien d dans de des depuis devrait devraient dire dis dit dites
  doit doivent donc dont du elle elles en encore entre es est et etaient etais etait etant ete etre eu eux fait faire
  faut fois font hors ici il ils j je jusqu l la le les leur leurs lui m ma mais me meme memes mes moi moins mon n ne
  ni non nos notre nous on ont ou par parce pas peu peut peuvent peux plus plutot pour pourquoi pourrait pres
  propose proposez propos prevoit prevu programme qu quand que quel quelle quelles quels qui quoi s sa sans se selon
  ses seront si sien son sont sous suis sur t ta te tes toi ton tous tout toute toutes tres tu un une unes uns va vais
  vers veut veux via vos votre vous vu y oui merci bonjour salut svp stp exemple chose choses rien
  y-a-t-il est-ce existe parle parler explique expliquer sait savoir mesure mesures
  `
    .split(/\s+/)
    .filter(Boolean),
);

/** Clé de regroupement : sans casse, sans accents, sans pluriel simple (« Écoles », « ecole » → « ecole »). */
function cle(mot: string): string {
  const sansAccents = mot.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  // Pluriel simple : « retraites » → « retraite », « impots » → « impot ». Pas sur les mots courts (« gaz », « bus »).
  return sansAccents.length > 4 ? sansAccents.replace(/[sx]$/, "") : sansAccents;
}

/** Mots d'une question : lettres, chiffres exclus, élisions (« l'école ») coupées. */
export function mots(question: string): string[] {
  return (question.normalize("NFC").match(/\p{L}+(?:-\p{L}+)*/gu) ?? [])
    .map((m) => m.toLowerCase())
    .filter((m) => m.length >= 3 && !MOTS_VIDES.has(m.normalize("NFD").replace(/\p{M}/gu, "")));
}

export function motsCles(questions: QuestionPosee[], { limite = 100, minPersonnes = 2 }: OptionsMotsCles = {}): MotCle[] {
  const parCle = new Map<string, { questions: number; personnes: Set<string>; formes: Map<string, number> }>();
  for (const q of questions) {
    const vus = new Set<string>();
    for (const forme of mots(q.content)) {
      const k = cle(forme);
      let e = parCle.get(k);
      if (!e) parCle.set(k, (e = { questions: 0, personnes: new Set(), formes: new Map() }));
      e.formes.set(forme, (e.formes.get(forme) ?? 0) + 1);
      if (vus.has(k)) continue;
      vus.add(k);
      e.questions++;
      e.personnes.add(q.pseudo);
    }
  }
  const gardes = [...parCle.values()]
    .filter((e) => e.personnes.size >= minPersonnes)
    .map((e) => ({
      // Forme la plus employée ; à égalité, la plus courte (le singulier).
      mot: [...e.formes].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))[0]![0],
      questions: e.questions,
      personnes: e.personnes.size,
    }))
    .sort((a, b) => b.questions - a.questions || b.personnes - a.personnes || a.mot.localeCompare(b.mot, "fr"))
    .slice(0, limite);
  const max = gardes[0]?.questions ?? 1;
  return gardes.map((m) => ({ ...m, poids: Math.round((m.questions / max) * 1000) / 1000 }));
}

const echapper = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Page HTML autonome : le nuage, mots mélangés, taille selon le poids. */
export function nuageHtml(motsCles: MotCle[], { jours }: { jours: number }): string {
  // Ordre alphabétique : stable d'un appel à l'autre, et les gros mots ne sont pas tous au début.
  const ordre = [...motsCles].sort((a, b) => a.mot.localeCompare(b.mot, "fr"));
  const items = ordre
    .map((m) => {
      const taille = (0.9 + m.poids * 2.6).toFixed(2);
      const teinte = Math.round(m.poids * 4);
      return `<li class="t${teinte}" style="font-size:${taille}rem" title="${m.questions} question(s), ${m.personnes} personne(s)">${echapper(m.mot)}</li>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mots-clés demandés</title>
<style>
  :root { --fond: #fbfaf7; --texte: #1f1d1a; --doux: #6b665e; --t0: #8c8478; --t1: #7a5c3e; --t2: #a3461f; --t3: #c0391b; --t4: #9b1d20; }
  @media (prefers-color-scheme: dark) {
    :root { --fond: #171614; --texte: #ece8e1; --doux: #a39d93; --t0: #8f887d; --t1: #c49a6c; --t2: #e07a4a; --t3: #f0654a; --t4: #ff7b6b; }
  }
  body { margin: 0; background: var(--fond); color: var(--texte); font: 16px/1.4 system-ui, sans-serif; }
  main { max-width: 960px; margin: 0 auto; padding: 32px 16px; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  p { color: var(--doux); margin: 0 0 24px; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; align-items: baseline;
       justify-content: center; gap: 6px 18px; }
  li { font-weight: 600; line-height: 1.1; cursor: default; }
  .t0 { color: var(--t0); font-weight: 500; } .t1 { color: var(--t1); } .t2 { color: var(--t2); }
  .t3 { color: var(--t3); } .t4 { color: var(--t4); font-weight: 700; }
</style>
</head>
<body>
<main>
<h1>Mots-clés les plus demandés</h1>
<p>${motsCles.length} mots, questions des ${jours} derniers jours. Survoler un mot pour ses chiffres.</p>
${motsCles.length ? `<ul>\n${items}\n</ul>` : "<p>Pas encore assez de questions.</p>"}
</main>
</body>
</html>`;
}
