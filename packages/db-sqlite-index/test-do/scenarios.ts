import { ngramDoScenarios } from "./ngram-smoke.js";
import { vectorDoScenarios } from "./vector-smoke.js";

/** Every smoke scenario the real-DO suite runs. Names must be unique. */
export const SCENARIOS = [...vectorDoScenarios, ...ngramDoScenarios];
