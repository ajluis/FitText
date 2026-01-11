import { config } from '../config';

const USDA_BASE_URL = 'https://api.nal.usda.gov/fdc/v1';

export interface USDAFood {
  fdcId: number;
  description: string;
  dataType: string;
  brandOwner?: string;
  brandName?: string;
  foodNutrients: {
    nutrientId: number;
    nutrientName: string;
    nutrientNumber: string;
    unitName: string;
    value: number;
  }[];
  servingSize?: number;
  servingSizeUnit?: string;
}

export interface USDASearchResult {
  foods: USDAFood[];
  totalHits: number;
  currentPage: number;
  totalPages: number;
}

// Nutrient IDs we care about
const NUTRIENT_IDS = {
  calories: 1008,  // Energy (kcal)
  protein: 1003,   // Protein
  carbs: 1005,     // Carbohydrates
  fat: 1004,       // Total fat
  fiber: 1079,     // Fiber
  sugar: 2000,     // Total sugars
} as const;

export interface NutritionInfo {
  name: string;
  calories: number;
  protein: number;
  carbs?: number;
  fat?: number;
  servingSize?: string;
  source: 'usda' | 'estimated';
}

/**
 * Search USDA database for foods
 */
export async function searchFoods(query: string, pageSize = 5): Promise<USDAFood[]> {
  try {
    const response = await fetch(`${USDA_BASE_URL}/foods/search?api_key=${config.usda.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        pageSize,
        dataType: ['Foundation', 'SR Legacy', 'Branded'],
        sortBy: 'dataType.keyword',
        sortOrder: 'asc',
      }),
    });

    if (!response.ok) {
      console.error('USDA API error:', response.status, await response.text());
      return [];
    }

    const data = await response.json() as USDASearchResult;
    return data.foods || [];
  } catch (error) {
    console.error('USDA search error:', error);
    return [];
  }
}

/**
 * Get nutrition info from a USDA food item
 */
export function extractNutrition(food: USDAFood): NutritionInfo {
  const getNutrient = (id: number): number => {
    const nutrient = food.foodNutrients.find(n => n.nutrientId === id);
    return nutrient?.value ?? 0;
  };

  // USDA values are per 100g, we'll note that in serving size
  const servingSize = food.servingSize && food.servingSizeUnit
    ? `${food.servingSize}${food.servingSizeUnit}`
    : '100g';

  return {
    name: food.description,
    calories: Math.round(getNutrient(NUTRIENT_IDS.calories)),
    protein: Math.round(getNutrient(NUTRIENT_IDS.protein)),
    carbs: Math.round(getNutrient(NUTRIENT_IDS.carbs)),
    fat: Math.round(getNutrient(NUTRIENT_IDS.fat)),
    servingSize,
    source: 'usda',
  };
}

/**
 * Look up a food and get nutrition info
 * Returns the best match or null if not found
 */
export async function lookupFood(query: string): Promise<NutritionInfo | null> {
  const foods = await searchFoods(query, 1);

  if (foods.length === 0) {
    return null;
  }

  return extractNutrition(foods[0]);
}

/**
 * Common portion sizes for scaling USDA data (which is per 100g)
 */
export const PORTION_MULTIPLIERS: Record<string, number> = {
  // General
  'small': 0.75,
  'medium': 1.0,
  'large': 1.5,

  // Cups
  'cup': 2.4,      // ~240g
  '1/2 cup': 1.2,
  '1/4 cup': 0.6,

  // Tablespoons
  'tbsp': 0.15,
  'tablespoon': 0.15,

  // Pieces/servings (rough estimates)
  'slice': 0.3,
  'piece': 1.0,

  // Ounces
  'oz': 0.28,
  'ounce': 0.28,

  // Specific to common foods
  'egg': 0.5,      // ~50g per egg
  'banana': 1.18,  // ~118g per medium banana
  'apple': 1.82,   // ~182g per medium apple
};

/**
 * Scale nutrition values by portion
 */
export function scaleNutrition(nutrition: NutritionInfo, multiplier: number): NutritionInfo {
  return {
    ...nutrition,
    calories: Math.round(nutrition.calories * multiplier),
    protein: Math.round(nutrition.protein * multiplier),
    carbs: nutrition.carbs ? Math.round(nutrition.carbs * multiplier) : undefined,
    fat: nutrition.fat ? Math.round(nutrition.fat * multiplier) : undefined,
  };
}
