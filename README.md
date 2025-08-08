# Earnings Alert App

Diese App zeigt dir, welche Unternehmen heute Quartalszahlen veröffentlichen, und analysiert automatisch die IR-Mitteilungen per GPT.

## Starten (lokal)

```bash
pip install -r requirements.txt
streamlit run streamlit_app.py
```

## Deployment auf Streamlit Cloud

1. Lade dieses Repository zu GitHub hoch
2. Gehe zu [https://share.streamlit.io](https://share.streamlit.io)
3. Wähle dein Repo + `streamlit_app.py`
4. Deploy klicken – fertig

## OpenAI API Key

Den Key kannst du als `.env` Datei anlegen mit:

```
OPENAI_API_KEY=sk-...
```

Oder du setzt ihn als Secret in Streamlit Cloud.

