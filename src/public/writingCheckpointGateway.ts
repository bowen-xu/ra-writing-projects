/** Public checkpoint access. Browser state stays with the plugin; App supplies
 * the native codec/transport through the existing Core runtime capability. */
export { getWritingCheckpointGateway } from "../features/writing/gateway/writingCheckpointGateway";
export type { WritingCheckpointGateway } from "./contracts/writingCheckpointGateway";
