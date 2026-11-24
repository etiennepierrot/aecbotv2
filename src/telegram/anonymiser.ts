/**
 * Copie anonymisée d'une question : ce qui pourrait identifier son auteur est masqué.
 * Gardée sans limite de durée (aec_questions_anonymes), sans pseudonyme ni heure.
 */

const MOTIFS: [RegExp, string][] = [
  // Adresses électroniques, avant les liens (« a@b.fr » ressemble à un domaine).
  [/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu, "[courriel]"],
  [/\bhttps?:\/\/\S+|\bwww\.\S+/giu, "[lien]"],
  // Comptes de réseaux sociaux : @pseudo.
  [/(^|[\s(])@[\w.]{2,}/gu, "$1[compte]"],
  // IBAN.
  [/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}(?:\s?[A-Z0-9]{1,3})?\b/g, "[iban]"],
  // Téléphones : +33 6 12 34 56 78, 06.12.34.56.78, 0612345678…
  [/(?:\+\d{1,3}[\s.-]?)?\(?0?\d\)?(?:[\s.-]?\d{2}){4}\b/g, "[téléphone]"],
  // Toute autre suite de 6 chiffres ou plus (numéro de sécurité sociale, d'allocataire, de dossier…).
  // Les montants et années (« 1600 euros », « 2027 ») restent.
  [/\d(?:[\s.-]?\d){5,}/g, "[numéro]"],
];

export function anonymiserQuestion(question: string): string {
  let texte = question.normalize("NFC");
  for (const [motif, remplacement] of MOTIFS) texte = texte.replace(motif, remplacement);
  return texte.replace(/\s+/g, " ").trim();
}
