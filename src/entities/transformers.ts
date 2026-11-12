import { ValueTransformer } from "typeorm";

// pg returns bigint columns as strings; the API exposes numeric ids.
// Ids stay far below Number.MAX_SAFE_INTEGER, so the conversion is lossless.
export const bigintTransformer: ValueTransformer = {
  to: (value?: number | null) => value,
  from: (value?: string | null) =>
    value === null || value === undefined ? value : Number(value),
};
