import express from "express";
import fs from "fs/promises";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import morgan from "morgan";
import { validators, readonlyProperties } from "./schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3001;

// Middleware
app.use(
  morgan("dev", {
    skip: (req) => req.method === "OPTIONS",
  })
);
app.use(
  cors({
    origin: "*",
    credentials: true,
  })
);
app.use(express.json({ limit: "Infinity" }));

// **CACHE in memoria** for each resource type
const cache = {};

// **Coda per scritture asincrone** for each resource type
const writeQueues = {};

// Helper to get plural form (basic pluralization rules)
function getPlural(singular) {
  if (singular.endsWith("y")) {
    return singular.slice(0, -1) + "ies";
  } else if (
    singular.endsWith("s") ||
    singular.endsWith("x") ||
    singular.endsWith("z") ||
    singular.endsWith("ch") ||
    singular.endsWith("sh")
  ) {
    return singular + "es";
  } else {
    return singular + "s";
  }
}

// Extract resource types from validators
const resourceTypes = Object.keys(validators);

// Initialize cache and write queues for each resource type
resourceTypes.forEach((type) => {
  cache[type] = [];
  writeQueues[type] = [];
});

// **Gestore della coda di scrittura**
const processWriteQueue = async (type) => {
  if (writeQueues[type].length === 0) return;
  const task = writeQueues[type].shift(); // Prende la prima operazione in coda
  await task(); // Esegue l'operazione
  if (writeQueues[type].length > 0) {
    setImmediate(() => processWriteQueue(type)); // Continua con la prossima operazione
  }
};

// Helper function to format validation errors in a readable way
function formatValidationErrors(errors) {
  let formattedMessage = "";
  const fieldErrors = {};

  // Group errors by field
  errors.forEach((error) => {
    if (!fieldErrors[error.field]) {
      fieldErrors[error.field] = [];
    }
    fieldErrors[error.field].push(error.message);
  });

  // Format each field's errors
  for (const [field, messages] of Object.entries(fieldErrors)) {
    const fieldName = field || "Generale";
    formattedMessage += `\n   • ${fieldName}: ${messages.join(", ")}`;
  }

  return formattedMessage;
}

// **Caricare i dati all'avvio**
const loadData = async (type) => {
  const dbDir = path.join(__dirname, "database");
  const dataFile = path.join(dbDir, `${type}.json`);
  try {
    // Check if database directory exists, create it if not
    if (!existsSync(dbDir)) {
      await fs.mkdir(dbDir, { recursive: true });
      console.log(`Directory del database creata.`);
    }

    if (existsSync(dataFile)) {
      const data = await fs.readFile(dataFile, "utf-8");
      if (data.trim()) {
        try {
          const loadedData = JSON.parse(data);

          // Verifica che i dati caricati siano in formato array
          if (!Array.isArray(loadedData)) {
            throw new Error(
              `Errore di struttura nel file ${type}.json: il file deve contenere un array.`
            );
          } else {
            // Valida ogni elemento nell'array usando il validator appropriato
            const validator = validators[type];
            const invalidItems = [];

            for (let i = 0; i < loadedData.length; i++) {
              const item = loadedData[i];
              const validationResult = validator(item);
              if (!validationResult.valid) {
                invalidItems.push({
                  index: i,
                  id: item.id || "sconosciuto",
                  errors: validationResult.errors,
                });
              }
            }

            if (invalidItems.length > 0) {
              let errorMessage = `\n⛔ Errori di validazione nel file ${type}.json. Il server non può partire.\n`;

              invalidItems.forEach((item) => {
                errorMessage += `\n🚫 Elemento #${item.index + 1} (ID: ${
                  item.id
                }) non valido:`;
                errorMessage += formatValidationErrors(item.errors);
                errorMessage += "\n";
              });

              errorMessage += `\nCorreggi questi errori nel file database/${type}.json per avviare il server.`;
              throw new Error(errorMessage);
            }

            cache[type] = loadedData;
          }
        } catch (parseError) {
          throw new Error(
            `Errore di sintassi JSON nel file ${type}.json:\n${parseError.message}\nControlla la sintassi del file e assicurati che sia un JSON valido.`
          );
        }
      } else {
        cache[type] = [];
      }
    } else {
      cache[type] = [];
      await saveData(type); // Create empty file
      console.log(`Creato file dati vuoto per ${type}.`);
    }
  } catch (error) {
    // Rilancia l'errore per gestirlo nel Promise.all
    throw error;
  }
};

// **Salvare i dati nel file (usando la coda)**
const saveData = async (type) => {
  return new Promise((resolve) => {
    writeQueues[type].push(async () => {
      try {
        const dataFile = path.join(__dirname, "database", `${type}.json`);
        await fs.writeFile(
          dataFile,
          JSON.stringify(cache[type], null, 2),
          "utf-8"
        );
        console.log(`Dati salvati in ${type}.json.`);
      } catch (error) {
        console.error(`⚠️ Errore nel salvare i dati per ${type}:`, error);
      }
      resolve();
    });
    if (writeQueues[type].length === 1) {
      processWriteQueue(type); // Avvia la scrittura solo se la coda era vuota
    }
  });
};

// Dynamically create routes for each resource type
const loadPromises = resourceTypes.map((type) => {
  const pluralType = getPlural(type);
  const validator = validators[type];

  // POST
  app.post(`/${pluralType}`, async (req, res) => {
    const validationResult = validator(req.body);
    if (!validationResult.valid) {
      return res.status(400).json({
        error: `Invalid ${type} data`,
        details: validationResult.errors,
      });
    }

    const newItem = req.body;
    delete newItem.id;
    if (!newItem.slug) {
      return res.status(400).json({ error: "Slug obbligatorio" });
    }
    if (cache[type].some((item) => item.slug === newItem.slug)) {
      return res.status(409).json({ error: "Slug già esistente" });
    }
    const creationDate = new Date();
    newItem.createdAt = creationDate.toISOString();
    newItem.updatedAt = creationDate.toISOString();
    cache[type].push(newItem);
    await saveData(type);
    res.status(201).json({ success: true, [type]: newItem });
  });

  // GET by slug
  app.get(`/${pluralType}/:slug`, (req, res) => {
    const itemSlug = req.params.slug;
    const item = cache[type].find((p) => p.slug === itemSlug);
    if (!item) {
      return res
        .status(404)
        .json({
          success: false,
          message: `${type} con slug '${itemSlug}' non trovato.`,
        });
    }
    res.json({ success: true, [type]: item });
  });

  // PUT by slug
  app.put(`/${pluralType}/:slug`, async (req, res) => {
    const itemSlug = req.params.slug;
    const itemIndex = cache[type].findIndex((p) => p.slug === itemSlug);
    if (itemIndex === -1) {
      return res
        .status(404)
        .json({
          success: false,
          message: `${type} con slug '${itemSlug}' non trovato.`,
        });
    }
    const oldItem = cache[type][itemIndex];

    const updatedFields = { ...req.body };
    delete updatedFields.slug;
    delete updatedFields.id;
    delete updatedFields.createdAt;
    delete updatedFields.updatedAt;

    const typeReadonlyProps = readonlyProperties[type] || [];
    const readonlyAttemptsToUpdate = Object.keys(updatedFields).filter((key) =>
      typeReadonlyProps.includes(key)
    );

    if (readonlyAttemptsToUpdate.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Non puoi modificare proprietà readonly: ${readonlyAttemptsToUpdate.join(
          ", "
        )}`,
      });
    }

    const fieldsToValidate = {};
    Object.keys(updatedFields).forEach((key) => {
      fieldsToValidate[key] = updatedFields[key];
    });

    if (Object.keys(fieldsToValidate).length > 0) {
      const validationResult = validator({ ...oldItem, ...fieldsToValidate });
      if (!validationResult.valid) {
        return res.status(400).json({
          error: `Dati ${type} non validi`,
          details: validationResult.errors,
        });
      }
    }

    const now = new Date().toISOString();
    cache[type][itemIndex] = {
      ...cache[type][itemIndex],
      ...updatedFields,
      updatedAt: now,
    };

    await saveData(type);
    res.json({ success: true, [type]: cache[type][itemIndex] });
  });

  // DELETE (non modificato)
  app.delete(`/${pluralType}/:id`, async (req, res) => {
    const itemId = parseInt(req.params.id);
    const filteredItems = cache[type].filter((p) => p.id !== itemId);
    if (filteredItems.length === cache[type].length) {
      return res
        .status(404)
        .json({
          success: false,
          message: `${type} with id '${itemId}' not found.`,
        });
    }

    cache[type] = filteredItems;
    await saveData(type);
    res.json({ success: true });
  });

  // GET all
  app.get(`/${pluralType}`, (req, res) => {
    res.json({ success: true, [pluralType]: cache[type] });
  });

  return loadData(type);
});

// Caricamento iniziale dati e avvio server
Promise.all(loadPromises)
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server started on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Errore durante il caricamento dati:", err.message);
    process.exit(1);
  });
