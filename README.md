# Auto CV Scoring Engine

This repository contains an automated CV scoring engine designed to evaluate and score resumes based on various criteria.

## Features

- Automated CV parsing and analysis
- Scoring based on skills and experience
- Customizable scoring metrics

## First Time Setup

- Ensure you have Node.js on your machine.
- Clone the repository and install dependencies:

  ```bash
  git clone <repository-url>
  cd cv-engine
  npm install
  ```

## Usage

- Add CVs to score to `cvs/` directory.
- Start the engine by running:

  ```bash
  node score-cvs.cjs

  ```

- View the scored CVs in the `reports/` directory.

## How It Works

- The engine processes uploaded CVs and extracts relevant information such as skills & experience.
- It then compares this information against predefined scoring metrics to generate a score for each CV.
- The scores help recruiters identify the most suitable candidates for their job openings.

## Licensing

This project is licensed under the MIT License. See the [LICENSE](./LICENSE) file for details.

## Acknowledgements

- Inspired by the need to view and analyze CVs effectively.
- Thanks to the open-source community for tools and libraries used in this project.

## Authors

- [Makkahwi](https://github.com/makkahwi/) - Initial work and ongoing maintenance.
- [ChatGPT](https://chat.openai.com/) - Assistance with code suggestions.
- [CoPilot](https://github.com/features/copilot) - Documentation completion and suggestions.

## Contributing

Contributions are welcome! Please fork the repository and submit a pull request with your changes.

## Contact

For any questions or support, please contact the maintainer [Makkahwi](https://github.com/makkahwi/)
