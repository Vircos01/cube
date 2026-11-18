"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VersionConflictError = void 0;
class VersionConflictError extends Error {
    modelId;
    expectedRevision;
    currentRevision;
    currentChangeSummary;
    currentUpdatedBy;
    modelName;
    currentRevisionId;
    constructor(modelId, expectedRevision, currentRevision, currentChangeSummary, currentUpdatedBy, modelName, currentRevisionId) {
        super(`Versieconflict op model ${modelId}: de verwachte revisie (${expectedRevision}) komt niet overeen met de huidige actieve revisie (${currentRevision}). Het model is tussentijds gewijzigd door een andere beheerder.`);
        this.modelId = modelId;
        this.expectedRevision = expectedRevision;
        this.currentRevision = currentRevision;
        this.currentChangeSummary = currentChangeSummary;
        this.currentUpdatedBy = currentUpdatedBy;
        this.modelName = modelName;
        this.currentRevisionId = currentRevisionId;
        this.name = 'VersionConflictError';
    }
}
exports.VersionConflictError = VersionConflictError;
//# sourceMappingURL=types.js.map