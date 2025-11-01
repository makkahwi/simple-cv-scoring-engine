# Auto CV Scoring Engine

This repository contains an automated CV scoring engine designed to evaluate and score resumes based on various criteria. The engine utilizes machine learning algorithms to analyze the content and structure of CVs, providing recruiters with a quick and efficient way to assess candidates.

## How It Works

- The engine processes uploaded CVs and extracts relevant information such as skills, experience, and education.
- It then compares this information against predefined scoring metrics to generate a score for each CV.
- The scores help recruiters identify the most suitable candidates for their job openings.

## First Time Setup

- Ensure you have Node.js on your machine.
- Clone the repository and install dependencies:
  ```bash
  git clone <repository-url>
  cd cv-engine
  npm install
  ```
- Create a `.env` file in the root directory and add your OpenAI API key:
  ```bash
  OPENAI_API_KEY=<your-api-key>
  ```
- Add your CVs to the `cvs/` directory.
- Start the engine by running:

  ```bash
  node score-cvs.mjs

  ```
