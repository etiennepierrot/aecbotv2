import { MastraPlatformExporter } from "@mastra/observability";

/**
 * Copie des traces et du feedback vers le tableau de bord Mastra Cloud (Observability).
 *
 * Inactif sans `MASTRA_PLATFORM_ACCESS_TOKEN` (ou `MASTRA_CLOUD_ACCESS_TOKEN`) : en local et en
 * test, rien ne part. `MASTRA_PROJECT_ID` rattache les données au projet (voir .mastra-project.json).
 *
 * Ces copies sortent de la base Neon : elles suivent la conservation de Mastra Cloud, et /oublier
 * ne les efface pas.
 */
export const cloudExporter = new MastraPlatformExporter();
