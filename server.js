const express = require('express');
const fs = require('fs');
const path = require('path');
// API Key などの環境変数は .env.local から読み込む
require('dotenv').config({ path: '.env.local' });

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static('public'));

// ===== 設定 =====
// 利用するLLMプロバイダを選択します（'openai' または 'gemini'）
const PROVIDER = 'openai';

// プロバイダごとに利用するモデル
const MODELS = {
    openai: 'gpt-6-luna',        // OpenAI（デフォルト）
    gemini: 'gemini-4-hydrogen', // Google Gemini
};
const MODEL = MODELS[PROVIDER];

let promptTemplate;
try {
    promptTemplate = fs.readFileSync('prompt.md', 'utf8');
} catch (error) {
    console.error('Error reading prompt.md:', error);
    process.exit(1);
}

const OPENAI_API_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
const LEADERBOARD_FILE = path.join(__dirname, 'leaderboard.json');
const STARTING_ASSETS = 10000000;
const CORRECT_ASSET_CHANGE = 1000000;
const INCORRECT_ASSET_CHANGE = -500000;

// public/ 内の .html 一覧を返す（index.html がこの一覧を使ってリンクを表示する）
app.get('/api/pages', (req, res) => {
    const files = fs.readdirSync('public')
        .filter(name => name.endsWith('.html') && name !== 'index.html' && name !== 'ranking.html');
    res.json(files);
});

// 個人を特定しないニックネームと、各プレイヤーの最高総資産を保存する
app.get('/api/leaderboard', (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        const entries = readLeaderboard().map(({ name, assets, correct, total }) => ({
            name,
            assets,
            correct,
            total
        }));
        res.json({ entries });
    } catch (error) {
        console.error('Leaderboard read error:', error);
        res.status(500).json({ error: 'Failed to read leaderboard.' });
    }
});

app.post('/api/leaderboard', (req, res) => {
    const { playerId, name, assets, correct, total } = req.body || {};
    const normalizedName = typeof name === 'string'
        ? Array.from(name.trim()).slice(0, 12).join('')
        : '';

    if (typeof playerId !== 'string' || !/^[0-9a-f-]{36}$/i.test(playerId)) {
        return res.status(400).json({ error: 'Invalid player ID.' });
    }
    if (!normalizedName || /[\u0000-\u001f\u007f]/.test(normalizedName)) {
        return res.status(400).json({ error: 'A valid nickname is required.' });
    }
    if (!Number.isInteger(total) || total < 1 || total > MAX_COUNT ||
        !Number.isInteger(correct) || correct < 0 || correct > total) {
        return res.status(400).json({ error: 'Invalid game result.' });
    }

    const expectedAssets = STARTING_ASSETS +
        (correct * CORRECT_ASSET_CHANGE) +
        ((total - correct) * INCORRECT_ASSET_CHANGE);
    if (assets !== expectedAssets) {
        return res.status(400).json({ error: 'Invalid asset total.' });
    }

    try {
        const entries = readLeaderboard();
        // ニックネームを変えた場合は別のランキング参加者として記録する
        const existingIndex = entries.findIndex(entry =>
            entry.playerId === playerId && entry.name === normalizedName);
        const existing = existingIndex >= 0 ? entries[existingIndex] : null;
        const isNewBest = !existing || expectedAssets >= existing.assets;
        const result = {
            ...existing,
            playerId,
            name: normalizedName,
            assets: isNewBest ? expectedAssets : existing.assets,
            correct: isNewBest ? correct : existing.correct,
            total: isNewBest ? total : existing.total,
            updatedAt: new Date().toISOString()
        };

        // 同じニックネームの最高記録を維持し、初回は別枠で追加する
        if (!existing || isNewBest) {
            if (existingIndex >= 0) entries[existingIndex] = result;
            else entries.push(result);
            writeLeaderboard(entries);
        }

        const rank = entries
            .sort((a, b) => b.assets - a.assets || b.correct - a.correct)
            .findIndex(entry => entry.playerId === playerId && entry.name === normalizedName) + 1;
        res.json({
            ok: true,
            rank,
            record: { name: result.name, assets: result.assets }
        });
    } catch (error) {
        console.error('Leaderboard write error:', error);
        res.status(500).json({ error: 'Failed to save leaderboard result.' });
    }
});

function readLeaderboard() {
    try {
        const savedEntries = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
        if (!Array.isArray(savedEntries)) throw new Error('Invalid leaderboard format.');
        return savedEntries
            .filter(entry => entry && typeof entry.playerId === 'string' &&
                typeof entry.name === 'string' && Number.isInteger(entry.assets))
            .sort((a, b) => b.assets - a.assets || b.correct - a.correct);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

function writeLeaderboard(entries) {
    const sortedEntries = entries
        .sort((a, b) => b.assets - a.assets || b.correct - a.correct);
    const temporaryFile = `${LEADERBOARD_FILE}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(sortedEntries, null, 2), 'utf8');
    fs.renameSync(temporaryFile, LEADERBOARD_FILE);
}

// 問題数の上限（過剰なリクエストでトークンを浪費しないようにする）
const MAX_COUNT = 20;

app.post('/api/', async (req, res) => {
    try {
        // title と、変数置換に使うその他のキーを受け取る
        // （prompt.md がプロンプトを定義するので、リクエストでの上書きは許可しない）
        const { title = 'Generated Content', ...variables } = req.body;

        // count が指定されている場合は 1〜MAX_COUNT の範囲に収める
        if (variables.count !== undefined) {
            const count = Number(variables.count);
            if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
                return res.status(400).json({
                    error: `count must be an integer between 1 and ${MAX_COUNT}`,
                });
            }
        }

        // prompt.md のテンプレート変数 ${key} をリクエストの値で置換する
        const finalPrompt = fillTemplate(promptTemplate, variables);

        let result;
        if (PROVIDER === 'openai') {
            result = await callOpenAI(finalPrompt);
        } else if (PROVIDER === 'gemini') {
            result = await callGemini(finalPrompt);
        } else {
            return res.status(400).json({ error: 'Invalid provider configuration' });
        }

        res.json({
            title: title,
            data: result,
        });

    } catch (error) {
        // 詳細はサーバーログにのみ出力し、クライアントには汎用メッセージを返す
        console.error('API Error:', error);
        res.status(500).json({ error: 'Failed to generate content. Please try again.' });
    }
});

// prompt.md 内の ${key} を variables の値で安全に置換する
function fillTemplate(template, variables) {
    return template.replace(/\$\{(\w+)\}/g, (match, key) => {
        return Object.prototype.hasOwnProperty.call(variables, key)
            ? String(variables[key])
            : match; // 対応する値がなければそのまま残す
    });
}

async function callOpenAI(prompt) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY environment variable is not set');
    }

    const response = await fetch(OPENAI_API_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: MODEL,
            messages: [
                { role: 'system', content: prompt }
            ],
            // シナリオ本文・選択肢・解説を複数件生成するため、旧設定より余裕を持たせる。
            // GPT-6 の reasoning tokens も max_completion_tokens に含まれる。
            max_completion_tokens: 8192,
            reasoning_effort: 'low',
            response_format: { type: "json_object" }
        })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'OpenAI API error');
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice) {
        throw new Error('OpenAI returned no completion choice.');
    }
    if (choice.finish_reason === 'length') {
        throw new Error('OpenAI response was truncated at max_completion_tokens.');
    }
    const responseText = choice.message?.content;
    if (typeof responseText !== 'string') {
        throw new Error(`OpenAI returned no text content (finish_reason: ${choice.finish_reason}).`);
    }
    return extractArray(responseText);
}

async function callGemini(prompt) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY environment variable is not set');
    }

    const response = await fetch(`${GEMINI_API_BASE_URL}${MODEL}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            contents: [{
                parts: [{ text: prompt }]
            }],
            generationConfig: {
                // 思考型モデルでは思考トークンもこの上限に含まれるため、余裕を持たせる
                maxOutputTokens: 8192,
                response_mime_type: "application/json",
                // クイズ生成に深い思考は不要。HIGH（既定）だと思考で上限に達し JSON が途中で切れることがある
                thinkingConfig: { thinkingLevel: "LOW" }
            }
        })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'Gemini API error');
    }

    const data = await response.json();
    const responseText = data.candidates[0].content.parts[0].text;
    return extractArray(responseText);
}

// LLM が返した JSON 文字列をパースし、最初に見つかった配列を取り出す
function extractArray(responseText) {
    let parsedData;
    try {
        parsedData = JSON.parse(responseText);
    } catch (parseError) {
        throw new Error('Failed to parse LLM response: ' + parseError.message);
    }

    const arrayData = Object.values(parsedData).find(Array.isArray);
    if (!arrayData) {
        throw new Error('No array found in the LLM response object.');
    }
    return arrayData;
}

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Config: ${PROVIDER} - ${MODEL}`);
});
