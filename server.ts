import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import { fileURLToPath } from 'url';
import cors from 'cors';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import * as dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// --- HELPER FUNCTIONS ---
const logBuffer: string[] = [];
const MAX_LOGS = 1000;

function appendJobLog(tag: string, message: string) {
  const timestamp = new Date().toISOString();
  const logLine = `[${tag}] ${timestamp}: ${message}`;
  console.log(logLine);
  logBuffer.push(logLine);
  if (logBuffer.length > MAX_LOGS) {
    logBuffer.shift();
  }
}

// Configuration and state
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "444555191847-2cor6geg1sn9q4eg2seuovq7orne5dcc.apps.googleusercontent.com";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "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";

appendJobLog('SYS', `Gemini API Key detected: ${!!process.env.GEMINI_API_KEY}`);
if (process.env.GEMINI_API_KEY) {
  appendJobLog('SYS', `Gemini API Key starts with: ${process.env.GEMINI_API_KEY.substring(0, 4)}...`);
}

const TEMPLATE_ID = '12QbtSI4EbLbpOZFe-vkTBe7HTil_jBYim9Va2ZXi7cU';
const DESTINATION_FOLDER_ID = '1X0wwhmeAFPRjEeyRGQ5jsA6868InB_Ax'; 

const LAYOUT_ID_COVER = 'p88';
const LAYOUT_ID_CONTENT = 'p124';
const LAYOUT_ID_CHART = 'p114';

const UPLOAD_DIR = '/tmp/uploads/';
const upload = multer({ dest: UPLOAD_DIR });

let oauth2Client: any;
let userCredentials: any = null; 
const jobs = new Map();

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/userinfo.email',
];

app.use(cors());
app.use(express.json());

// Debug Request Logger
app.use((req, res, next) => {
  if (req.url.startsWith('/api')) {
    appendJobLog('SYS', `${req.method} ${req.url}`);
  }
  next();
});

// --- API ENDPOINTS ---

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', 'attachment; filename=medidata_engine_logs.txt');
  res.send(logBuffer.join('\n'));
});

// Provides the Gemini API key safely to the frontend (platform handles the env injection)
app.get('/api/config/gemini', (req, res) => {
  res.json({ apiKey: process.env.GEMINI_API_KEY });
});

app.get('/api/config/auth-debug', (req, res) => {
  const baseUrl = process.env.APP_URL || 'http://localhost:3000';
  const redirectUri = `${baseUrl.replace(/\/$/, '')}/oauth2callback`;
  res.json({
    APP_URL: process.env.APP_URL,
    detectedBaseUrl: baseUrl,
    computedRedirectUri: redirectUri,
    clientId: GOOGLE_CLIENT_ID ? (GOOGLE_CLIENT_ID.substring(0, 10) + '...') : 'MISSING'
  });
});

app.get('/api/auth/status', (req, res) => {
  if (userCredentials) res.json({ isAuthenticated: true, email: userCredentials.email });
  else res.json({ isAuthenticated: false });
});

app.get('/api/auth/login', (req, res) => {
  const frontendOrigin = req.query.origin as string || process.env.APP_URL || 'http://localhost:3000';
  const baseUrl = frontendOrigin.replace(/\/$/, '');
  const redirect_uris = `${baseUrl}/oauth2callback`;
  
  appendJobLog('AUTH', `Generating auth URL with redirect: ${redirect_uris}`);
  
  oauth2Client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, redirect_uris);
  const authUrl = oauth2Client.generateAuthUrl({ 
    access_type: 'offline', 
    scope: SCOPES, 
    prompt: 'consent',
    state: Buffer.from(baseUrl).toString('base64') // Encode origin to reconstruct URI
  });
  res.json({ authUrl });
});

app.get('/oauth2callback', async (req, res) => {
  const { code, state } = req.query;
  try {
    let baseUrl = process.env.APP_URL || 'http://localhost:3000';
    if (state) {
      baseUrl = Buffer.from(state as string, 'base64').toString('ascii');
    }
    const redirect_uris = `${baseUrl.replace(/\/$/, '')}/oauth2callback`;
    
    appendJobLog('AUTH', `Exchanging code with redirect: ${redirect_uris}`);
    
    const client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, redirect_uris);
    const { tokens } = await client.getToken(code as string);

    oauth2Client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, redirect_uris);
    oauth2Client.setCredentials(tokens);
    
    const oauth2 = google.oauth2({ auth: oauth2Client, version: 'v2' });
    const { data } = await oauth2.userinfo.get();
    
    userCredentials = { tokens: tokens, email: data.email };
    
    // Return HTML to signal success to the popup opener
    res.send(`
      <html>
        <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f0fdf4;">
          <div style="text-align: center; padding: 2rem; background: white; border-radius: 1rem; shadow: 0 10px 15px -3px rgba(0,0,0,0.1);">
            <h1 style="color: #16a34a; margin-bottom: 0.5rem;">Access Granted!</h1>
            <p style="color: #4b5563;">You can now close this window and start generating presentations.</p>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS' }, '*');
                setTimeout(() => window.close(), 1200);
              } else {
                // If it's not a popup or opener was lost, show a clear message instead of redirecting
                // Redirecting to / in a standalone window shows the 'App must be in iframe' error
                document.body.innerHTML = ' \
                  <div style="text-align: center; padding: 2rem; background: white; border-radius: 1rem; width: 90%; max-width: 400px; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1);"> \
                    <h1 style="color: #16a34a; margin-bottom: 0.5rem;">Access Granted!</h1> \
                    <p style="color: #4b5563;">Authentication successful. You can safely close this window and return to the main application.</p> \
                    <button onclick="window.close()" style="margin-top: 1.5rem; background: #16a34a; color: white; border: none; padding: 0.75rem 1.5rem; border-radius: 0.5rem; cursor: pointer; font-weight: 600;">Close Window</button> \
                  </div> \
                ';
              }
            </script>
          </div>
        </body>
      </html>
    `);
  } catch (error: any) { 
    console.error("Auth callback error:", error);
    res.status(500).send(`Authentication failed: ${error.message}`); 
  }
});

app.get('/api/auth/logout', (req, res) => { userCredentials = null; oauth2Client = null; res.json({ success: true }); });

app.post('/api/analysis', upload.single('file'), async (req, res) => {
  if (!userCredentials) return res.status(401).json({ error: 'User not authenticated' });
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Missing file' });

  try {
    const userAuthClient = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
    userAuthClient.setCredentials(userCredentials.tokens);
    const drive = google.drive({ version: 'v3', auth: userAuthClient });
    const sheets = google.sheets({ version: 'v4', auth: userAuthClient });

    // Upload and convert
    const { spreadsheetId } = await convertExcelToGoogleSheet(drive, file, 'analysis');
    
    // Get sample data for mapping (first 50 rows)
    let rows: any[] = [];
    let sheetNames: string[] = [];
    
    // Retry logic for sync
    for (let i = 0; i < 5; i++) {
        try {
            await new Promise(r => setTimeout(r, 2000));
            const sheet = await sheets.spreadsheets.get({ spreadsheetId });
            sheetNames = sheet.data.sheets!.map(s => s.properties!.title!);
            const response = await sheets.spreadsheets.values.get({ 
                spreadsheetId, 
                range: `${sheetNames[0]}!1:50` 
            });
            rows = response.data.values || [];
            if (rows.length > 0) break;
        } catch (e) {
            if (i === 4) throw e;
        }
    }

    res.json({ spreadsheetId, sheetNames, sampleRows: rows });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  } finally {
    if (file && file.path) try { await fsPromises.unlink(file.path); } catch(e) {}
  }
});

app.post('/api/slides/finalize', async (req, res) => {
  if (!userCredentials) return res.status(401).json({ error: 'User not authenticated' });
  const { title, spreadsheetId, slidesContent, sheetNames } = req.body;

  try {
    const userAuthClient = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
    userAuthClient.setCredentials(userCredentials.tokens);
    const drive = google.drive({ version: 'v3', auth: userAuthClient });
    const slides = google.slides({ version: 'v1', auth: userAuthClient });

    // Create presentation from template or fallback to fresh presentation
    const { presentationId, isTemplate } = await createOrCopyPresentation(drive, slides, title, undefined, userCredentials.email);
    
    // Process each slide content
    const presData = await slides.presentations.get({ presentationId });
    const existingSlides = presData.data.slides || [];
    const requests: any[] = [];

    for (let i = 0; i < slidesContent.length; i++) {
      const content = slidesContent[i];
      let pageId: string;
      const isNewSlide = !existingSlides[i];

      if (existingSlides[i]) {
        pageId = existingSlides[i].objectId;
      } else {
        pageId = `slide_gen_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
        requests.push({
          createSlide: {
            objectId: pageId,
            slideLayoutReference: { predefinedLayout: content.slide_type === 'title_slide' ? 'TITLE' : 'BLANK' }
          }
        });
      }

      // If template, try placeholder text replacements
      if (isTemplate) {
        const textMappings = {
          '{{TITLE}}': content.slide_title || '',
          '{{SUBTITLE}}': content.subtitle || '',
          '{{BODY}}': (content.main_points || []).join('\n'),
          '{{OBSERVATION}}': content.observation || '',
          '{{CLIENT}}': title || ''
        };

        Object.entries(textMappings).forEach(([tag, val]) => {
          requests.push({
            replaceAllText: {
              replaceText: String(val),
              containsText: { text: tag, matchCase: false },
              pageObjectIds: [pageId]
            }
          });
        });
      }

      // If it's a newly created slide (or fresh presentation), build custom styled slide elements
      if (isNewSlide || !isTemplate) {
        const isCover = content.slide_type === 'title_slide' || i === 0;

        if (isCover) {
          // Cover slide Title
          const titleBoxId = `${pageId}_title`;
          requests.push({
            createShape: {
              objectId: titleBoxId,
              shapeType: 'TEXT_BOX',
              elementProperties: {
                pageObjectId: pageId,
                size: { width: { magnitude: 620, unit: 'PT' }, height: { magnitude: 100, unit: 'PT' } },
                transform: { scaleX: 1, scaleY: 1, translateX: 50, translateY: 140, unit: 'PT' }
              }
            }
          });
          requests.push({
            insertText: { objectId: titleBoxId, insertionIndex: 0, text: content.slide_title || title }
          });
          requests.push({
            updateTextStyle: {
              objectId: titleBoxId,
              style: {
                bold: true,
                fontSize: { magnitude: 32, unit: 'PT' },
                foregroundColor: { opaqueColor: { rgbColor: { red: 0.0, green: 0.07, blue: 0.45 } } }
              },
              fields: 'bold,fontSize,foregroundColor'
            }
          });

          // Cover Subtitle
          const subBoxId = `${pageId}_subtitle`;
          requests.push({
            createShape: {
              objectId: subBoxId,
              shapeType: 'TEXT_BOX',
              elementProperties: {
                pageObjectId: pageId,
                size: { width: { magnitude: 620, unit: 'PT' }, height: { magnitude: 60, unit: 'PT' } },
                transform: { scaleX: 1, scaleY: 1, translateX: 50, translateY: 250, unit: 'PT' }
              }
            }
          });
          requests.push({
            insertText: { objectId: subBoxId, insertionIndex: 0, text: `${content.subtitle || 'Support Operations Strategic Review'} | Client: ${title}` }
          });
          requests.push({
            updateTextStyle: {
              objectId: subBoxId,
              style: {
                fontSize: { magnitude: 16, unit: 'PT' },
                foregroundColor: { opaqueColor: { rgbColor: { red: 0.0, green: 0.64, blue: 0.88 } } }
              },
              fields: 'fontSize,foregroundColor'
            }
          });
        } else {
          // Content Slide Header Title
          const titleBoxId = `${pageId}_title`;
          requests.push({
            createShape: {
              objectId: titleBoxId,
              shapeType: 'TEXT_BOX',
              elementProperties: {
                pageObjectId: pageId,
                size: { width: { magnitude: 640, unit: 'PT' }, height: { magnitude: 50, unit: 'PT' } },
                transform: { scaleX: 1, scaleY: 1, translateX: 40, translateY: 30, unit: 'PT' }
              }
            }
          });
          requests.push({
            insertText: { objectId: titleBoxId, insertionIndex: 0, text: content.slide_title || 'Key Insights' }
          });
          requests.push({
            updateTextStyle: {
              objectId: titleBoxId,
              style: {
                bold: true,
                fontSize: { magnitude: 22, unit: 'PT' },
                foregroundColor: { opaqueColor: { rgbColor: { red: 0.0, green: 0.07, blue: 0.45 } } }
              },
              fields: 'bold,fontSize,foregroundColor'
            }
          });

          // Main Points Text Box
          const pointsBoxId = `${pageId}_points`;
          const mainText = (content.main_points || []).map((p: string) => `•  ${p}`).join('\n\n');
          requests.push({
            createShape: {
              objectId: pointsBoxId,
              shapeType: 'TEXT_BOX',
              elementProperties: {
                pageObjectId: pageId,
                size: { width: { magnitude: 640, unit: 'PT' }, height: { magnitude: 180, unit: 'PT' } },
                transform: { scaleX: 1, scaleY: 1, translateX: 40, translateY: 95, unit: 'PT' }
              }
            }
          });
          requests.push({
            insertText: { objectId: pointsBoxId, insertionIndex: 0, text: mainText || '• Operational metrics review' }
          });
          requests.push({
            updateTextStyle: {
              objectId: pointsBoxId,
              style: {
                fontSize: { magnitude: 13, unit: 'PT' },
                foregroundColor: { opaqueColor: { rgbColor: { red: 0.2, green: 0.2, blue: 0.25 } } }
              },
              fields: 'fontSize,foregroundColor'
            }
          });

          // Strategic Observation Callout Box at Bottom
          if (content.observation) {
            const obsBoxId = `${pageId}_obs`;
            requests.push({
              createShape: {
                objectId: obsBoxId,
                shapeType: 'ROUND_RECTANGLE',
                elementProperties: {
                  pageObjectId: pageId,
                  size: { width: { magnitude: 640, unit: 'PT' }, height: { magnitude: 65, unit: 'PT' } },
                  transform: { scaleX: 1, scaleY: 1, translateX: 40, translateY: 295, unit: 'PT' }
                }
              }
            });
            requests.push({
              updateShapeProperties: {
                objectId: obsBoxId,
                shapeProperties: {
                  shapeBackgroundFill: {
                    solidFill: { color: { rgbColor: { red: 0.94, green: 0.97, blue: 1.0 } } }
                  },
                  outline: {
                    outlineFill: { solidFill: { color: { rgbColor: { red: 0.0, green: 0.64, blue: 0.88 } } } },
                    weight: { magnitude: 1, unit: 'PT' }
                  }
                },
                fields: 'shapeBackgroundFill,outline'
              }
            });
            requests.push({
              insertText: { objectId: obsBoxId, insertionIndex: 0, text: `STRATEGIC OBSERVATION:\n${content.observation}` }
            });
            requests.push({
              updateTextStyle: {
                objectId: obsBoxId,
                style: {
                  fontSize: { magnitude: 11, unit: 'PT' },
                  foregroundColor: { opaqueColor: { rgbColor: { red: 0.0, green: 0.12, blue: 0.35 } } }
                },
                fields: 'fontSize,foregroundColor'
              }
            });
          }
        }
      }
      
      appendJobLog('final', `Populated slide ${i + 1}: ${content.slide_title}`);
    }

    // Execute all updates in batches to prevent payload overflow
    if (requests.length > 0) {
      await slides.presentations.batchUpdate({ 
        presentationId, 
        requestBody: { requests } 
      });
    }

    res.json({ url: `https://docs.google.com/presentation/d/${presentationId}/edit` });
  } catch (error: any) {
    appendJobLog('ERROR', `Finalization failed: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

async function createOrCopyPresentation(drive: any, slides: any, title: string, customTemplateId?: string, userEmail?: string) {
  const templateToUse = customTemplateId || TEMPLATE_ID;

  if (templateToUse) {
    appendJobLog('final', `Attempting to copy template ${templateToUse}...`);
    try {
      const copyParams: any = {
        fileId: templateToUse,
        requestBody: { name: title },
        supportsAllDrives: true
      };
      if (DESTINATION_FOLDER_ID) {
        copyParams.requestBody.parents = [DESTINATION_FOLDER_ID];
      }
      const copy = await drive.files.copy(copyParams);
      appendJobLog('final', `Successfully copied template. Presentation ID: ${copy.data.id}`);
      return { presentationId: copy.data.id, isTemplate: true };
    } catch (e: any) {
      appendJobLog('WARN', `Template copy with destination folder failed (${e.message}). Retrying copy without parent folder...`);
      try {
        const copy = await drive.files.copy({
          fileId: templateToUse,
          requestBody: { name: title },
          supportsAllDrives: true
        });
        appendJobLog('final', `Successfully copied template. Presentation ID: ${copy.data.id}`);
        return { presentationId: copy.data.id, isTemplate: true };
      } catch (e2: any) {
        const userMsg = userEmail ? `for authorized account (${userEmail})` : '';
        const errorDetail = `Template presentation "${templateToUse}" could not be accessed ${userMsg}. Please ensure the template file is shared with ${userEmail || 'your Google account'} (Viewer or Editor access), or set to "Anyone with the link can view". Error details: ${e2.message}`;
        appendJobLog('ERROR', errorDetail);
        throw new Error(errorDetail);
      }
    }
  }

  // Fallback to creating a new Google Slides presentation directly
  const res = await slides.presentations.create({
    requestBody: { title }
  });
  appendJobLog('final', `Created fresh Google Slides presentation: ${res.data.presentationId}`);
  return { presentationId: res.data.presentationId, isTemplate: false };
}

async function convertExcelToGoogleSheet(drive: any, file: any, jobId: string) {
  try {
    const driveFile = await drive.files.create({
      requestBody: { name: `Temp_Excel_${jobId}`, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [DESTINATION_FOLDER_ID] },
      media: { mimeType: file.mimetype, body: fs.createReadStream(file.path) },
      supportsAllDrives: true
    });
    return { spreadsheetId: driveFile.data.id };
  } catch (e: any) {
    appendJobLog('WARN', `Folder upload failed (${e.message}). Uploading directly to user root drive...`);
    const driveFile = await drive.files.create({
      requestBody: { name: `Temp_Excel_${jobId}`, mimeType: 'application/vnd.google-apps.spreadsheet' },
      media: { mimeType: file.mimetype, body: fs.createReadStream(file.path) },
      supportsAllDrives: true
    });
    return { spreadsheetId: driveFile.data.id };
  }
}

// --- SERVER STARTUP ---
async function startServer() {
  console.log("Starting server...");
  
  try {
    if (!fs.existsSync(UPLOAD_DIR)) {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    }

    // Vite integration
    if (process.env.NODE_ENV !== 'production') {
      console.log("Initializing Vite dev middleware...");
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } else {
      console.log("Setting up production serving...");
      const distPath = path.join(process.cwd(), 'dist');
      app.use(express.static(distPath));
      app.get('*', (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }

    // Start listening
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server is running at http://0.0.0.0:${PORT}`);
    });
  } catch (error) {
    console.error("Critical error during server startup:", error);
    process.exit(1);
  }
}

startServer();

