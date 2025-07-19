// THIS FILE IS AUTO-GENERATED from types.ts - DO NOT EDIT DIRECTLY
import z from 'zod';


// Schema generated from types.ts Game type
export const GameSchema = z.object({
  id: z.number().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  title: z.string({ required_error: "Title is required" }),
  slug: z.string(),
  category: z.string({ required_error: "Category is required" }),
  releaseYear: z.number(),
  developer: z.string(),
  rating: z.string(),
  description: z.string(),
  price: z.string(),
  systemRequirements: z.any(),
  imagesExtra: z.array(z.string()),
  tags: z.array(z.string()),
  links: z.any(),
}).strict(); // Add strict mode to reject extra properties


export function validateGame(data) {
  try {
    const result = GameSchema.parse(data);
    return { valid: true, data: result };
  } catch (error) {
    return { 
      valid: false, 
      errors: error.errors.map(err => ({
        field: err.path.join('.'),
        message: err.message
      }))
    };
  }
}

// Export all validators as a map for dynamic usage
export const validators = {
  "game": validateGame
};

// Export readonly properties for each type to prevent updates
export const readonlyProperties = {
  "game": []
};
