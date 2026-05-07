import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { LEXICAL_SCHEMA } from "../constants/lexicalSchema";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const validate = ajv.compile(LEXICAL_SCHEMA);

export interface ValidationReport {
  isValid: boolean;
  errors: string[];
  metadata?: any;
}

export function validateLexicalDatabase(data: any): ValidationReport {
  const isValid = validate(data);
  
  if (isValid) {
    return {
      isValid: true,
      errors: [],
      metadata: (data as any).metadata
    };
  } else {
    return {
      isValid: false,
      errors: validate.errors?.map(err => `${err.instancePath} ${err.message}`) || ["Unknown validation error"]
    };
  }
}
