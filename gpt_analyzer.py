import openai
import os

openai.api_key = os.getenv("OPENAI_API_KEY")

def analyze(text):
    prompt = f"""
Bitte analysiere den folgenden Quartalsbericht und beantworte:

1. Was sind die wichtigsten Erkenntnisse? (Umsatz, Gewinn, Prognose)
2. Wie ist die Tonalität einzuschätzen? Positiv / Neutral / Negativ?
3. Welche Handlungsempfehlung ergibt sich für einen Privatanleger: Kaufen / Halten / Verkaufen?

Text:
"""{text}"""
    """
    response = openai.ChatCompletion.create(
        model="gpt-4",
        messages=[{"role": "user", "content": prompt}]
    )
    return response['choices'][0]['message']['content']
