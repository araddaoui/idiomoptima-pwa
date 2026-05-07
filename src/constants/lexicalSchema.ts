export const LEXICAL_SCHEMA = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://nativewrite.io/schemas/lexical-database-batch1.json",
  "title": "NativeWrite Lexical Database - Batch 1",
  "description": "JSON Schema for the 500-item lexical database covering collocations, phrasal verbs, idioms, chunks, bundles, and ESL error patterns.",
  "version": "1.0.0",
  "type": "object",
  "required": [
    "entries",
    "metadata"
  ],
  "properties": {
    "metadata": {
      "type": "object",
      "description": "Dataset-level metadata",
      "required": [
        "batch_id",
        "total_entries",
        "created_at",
        "source_format"
      ],
      "properties": {
        "batch_id": {
          "type": "string",
          "const": "batch1",
          "description": "Identifier for this dataset batch"
        },
        "total_entries": {
          "type": "integer",
          "minimum": 500,
          "maximum": 500,
          "description": "Total number of lexical entries"
        },
        "created_at": {
          "type": "string",
          "format": "date-time",
          "description": "ISO 8601 timestamp of dataset creation"
        },
        "source_format": {
          "type": "string",
          "const": "csv",
          "description": "Original source file format"
        },
        "categories": {
          "type": "array",
          "description": "High-level category summary",
          "items": {
            "type": "object",
            "properties": {
              "layer": {
                "type": "string"
              },
              "count": {
                "type": "integer"
              },
              "description": {
                "type": "string"
              }
            }
          }
        },
        "schema_version": {
          "type": "string",
          "const": "1.0.0"
        }
      }
    },
    "entries": {
      "type": "array",
      "description": "Array of lexical entries",
      "minItems": 500,
      "maxItems": 500,
      "items": {
        "type": "object",
        "required": [
          "id",
          "phrase",
          "type",
          "layer",
          "register",
          "genre",
          "purpose",
          "frequency_score"
        ],
        "properties": {
          "id": {
            "type": "integer",
            "minimum": 1,
            "maximum": 500,
            "description": "Unique sequential identifier"
          },
          "phrase": {
            "type": "string",
            "minLength": 1,
            "maxLength": 100,
            "description": "The lexical item (collocation, phrasal verb, idiom, chunk, or bundle)"
          },
          "type": {
            "type": "string",
            "enum": [
              "collocation",
              "phrasal_verb",
              "idiom",
              "chunk",
              "bundle"
            ],
            "description": "Lexical type classification"
          },
          "layer": {
            "type": "string",
            "enum": [
              "core_collocation",
              "academic",
              "business",
              "conversational",
              "literary",
              "esl_error"
            ],
            "description": "Proficiency/domain layer of the lexical item"
          },
          "register": {
            "type": "string",
            "enum": [
              "neutral",
              "formal",
              "informal",
              "professional",
              "literary"
            ],
            "description": "Formality level of the lexical item"
          },
          "genre": {
            "type": "string",
            "enum": [
              "general",
              "academic",
              "business",
              "conversation",
              "literary"
            ],
            "description": "Primary discourse genre where the item occurs"
          },
          "purpose": {
            "type": "string",
            "enum": [
              "correctness",
              "fluency",
              "argumentation",
              "cohesion",
              "style"
            ],
            "description": "Primary pedagogical purpose of the item"
          },
          "esl_error_trigger": {
            "type": "string",
            "description": "Associated ESL error pattern, or 'none' if this is a correct form"
          },
          "replacement_strength": {
            "type": "string",
            "enum": [
              "low",
              "medium",
              "high"
            ],
            "description": "How strongly the correct form replaces the ESL error"
          },
          "voice_risk": {
            "type": "string",
            "enum": [
              "low",
              "medium",
              "high"
            ],
            "description": "Risk of sounding unnatural or inauthentic if used incorrectly"
          },
          "frequency_score": {
            "type": "integer",
            "minimum": 1,
            "maximum": 10,
            "description": "Relative frequency/importance score (1=rare, 10=very common)"
          },
          "notes": {
            "type": "string",
            "maxLength": 500,
            "description": "Pedagogical notes, usage guidance, and error explanations"
          },
          "tags": {
            "type": "array",
            "description": "Derived semantic/structural tags for filtering",
            "items": {
              "type": "string"
            }
          }
        },
        "allOf": [
          {
            "if": {
              "properties": {
                "layer": {
                  "const": "esl_error"
                }
              }
            },
            "then": {
              "properties": {
                "esl_error_trigger": {
                  "type": "string",
                  "minLength": 1,
                  "description": "ESL error entries MUST specify the incorrect trigger form"
                }
              }
            }
          }
        ]
      }
    }
  }
};
