import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
const jsonValue = (value) => JSON.parse(JSON.stringify(value));

export function convert(model, doc) {
  const fields = model.fields.filter((field) => field.kind !== "object");
  const allowed = new Set(["_id", ...fields.map((field) => field.name)]);
  const extra = Object.keys(doc).filter((key) => !allowed.has(key));
  assert(!extra.length, `${model.name}: unmapped fields ${extra.join(", ")}`);
  const row = {};
  for (const field of fields) {
    let value = field.name === "id" ? doc._id ?? doc.id : doc[field.name];
    if (value === undefined) {
      if (!field.isRequired) { row[field.name] = field.type === "Json" ? Prisma.DbNull : null; continue; }
      if (field.hasDefaultValue && !field.isId) continue;
      throw new Error(`${model.name}.${field.name}: required field missing`);
    }
    if (value === null) {
      assert(!field.isRequired, `${model.name}.${field.name}: required field is null`);
      row[field.name] = field.type === "Json" ? Prisma.DbNull : null;
    } else if (field.type === "Json") {
      row[field.name] = jsonValue(value);
    } else if (field.type === "Bytes") {
      assert(Buffer.isBuffer(value) || value?._bsontype === "Binary", `${model.name}.${field.name}: invalid binary`);
      row[field.name] = Buffer.isBuffer(value) ? value : Buffer.from(value.value(true));
    } else if (field.type === "DateTime") {
      row[field.name] = new Date(value);
      assert(Number.isFinite(row[field.name].getTime()), `${model.name}.${field.name}: invalid date`);
    } else if (field.type === "String") {
      assert(typeof value === "string" || value?._bsontype === "ObjectId", `${model.name}.${field.name}: invalid string`);
      row[field.name] = String(value);
    } else {
      row[field.name] = value;
    }
  }
  return row;
}
