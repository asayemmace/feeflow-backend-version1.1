/**
 * useFeeStructure — shared hook that manages the school's fee configuration.
 *
 * Stored in localStorage so it survives page refreshes.
 * Shape:
 *   {
 *     classes: ["Form 1A", "Form 1B", ...],          // school-defined classes
 *     feeTypes: [                                      // global fee types
 *       { id, name, isCustom }
 *     ],
 *     feeMatrix: {                                     // per-class per-type fee
 *       "Form 1A": { tuition: 22000, lunch: 3000, ... }
 *     }
 *   }
 */

import { useState, useCallback } from "react";

const STORAGE_KEY = "feeflow_fee_structure";

const DEFAULT_FEE_TYPES = [
  { id: "tuition",    name: "Tuition",    isCustom: false },
  { id: "lunch",      name: "Lunch",      isCustom: false },
  { id: "activities", name: "Activities", isCustom: false },
  { id: "books",      name: "Books",      isCustom: false },
  { id: "others",     name: "Others",     isCustom: false },
];

const DEFAULT_CLASSES = [
  "Form 1A", "Form 1B", "Form 1C",
  "Form 2A", "Form 2B", "Form 2C",
  "Form 3A", "Form 3B", "Form 3C",
  "Form 4A", "Form 4B", "Form 4C",
];

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

function save(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {}
}

function getDefault() {
  return {
    classes: DEFAULT_CLASSES,
    feeTypes: DEFAULT_FEE_TYPES,
    feeMatrix: {},
  };
}

export function useFeeStructure() {
  const [structure, setStructure] = useState(() => load() || getDefault());

  const update = useCallback((fn) => {
    setStructure(prev => {
      const next = fn(prev);
      save(next);
      return next;
    });
  }, []);

  // ── classes ──────────────────────────────────────────────────────────────────
  const addClass = useCallback((name) => {
    const trimmed = name.trim();
    if (!trimmed) return false;
    update(s => {
      if (s.classes.includes(trimmed)) return s;
      return { ...s, classes: [...s.classes, trimmed] };
    });
    return true;
  }, [update]);

  const removeClass = useCallback((name) => {
    update(s => ({
      ...s,
      classes: s.classes.filter(c => c !== name),
      feeMatrix: Object.fromEntries(
        Object.entries(s.feeMatrix).filter(([k]) => k !== name)
      ),
    }));
  }, [update]);

  // ── fee types ────────────────────────────────────────────────────────────────
  const addFeeType = useCallback((name) => {
    const trimmed = name.trim();
    if (!trimmed) return false;
    const id = trimmed.toLowerCase().replace(/\s+/g, "_") + "_" + Date.now();
    update(s => ({
      ...s,
      feeTypes: [...s.feeTypes, { id, name: trimmed, isCustom: true }],
    }));
    return true;
  }, [update]);

  const removeFeeType = useCallback((id) => {
    update(s => ({
      ...s,
      feeTypes: s.feeTypes.filter(ft => ft.id !== id),
      feeMatrix: Object.fromEntries(
        Object.entries(s.feeMatrix).map(([cls, fees]) => {
          const { [id]: _, ...rest } = fees;
          return [cls, rest];
        })
      ),
    }));
  }, [update]);

  // ── matrix (per-class, per-type amounts) ────────────────────────────────────
  const setFee = useCallback((className, feeTypeId, amount) => {
    update(s => ({
      ...s,
      feeMatrix: {
        ...s.feeMatrix,
        [className]: {
          ...(s.feeMatrix[className] || {}),
          [feeTypeId]: Number(amount) || 0,
        },
      },
    }));
  }, [update]);

  const getFee = useCallback((className, feeTypeId) => {
    return structure.feeMatrix?.[className]?.[feeTypeId] || 0;
  }, [structure]);

  // Total fee for a class across selected types
  const getTotalFee = useCallback((className, selectedTypeIds = null) => {
    const matrix = structure.feeMatrix?.[className] || {};
    const ids = selectedTypeIds || structure.feeTypes.map(ft => ft.id);
    return ids.reduce((sum, id) => sum + (matrix[id] || 0), 0);
  }, [structure]);

  // Reset to defaults
  const resetToDefaults = useCallback(() => {
    const d = getDefault();
    save(d);
    setStructure(d);
  }, []);

  return {
    structure,
    classes: structure.classes,
    feeTypes: structure.feeTypes,
    feeMatrix: structure.feeMatrix,
    addClass,
    removeClass,
    addFeeType,
    removeFeeType,
    setFee,
    getFee,
    getTotalFee,
    resetToDefaults,
  };
}
