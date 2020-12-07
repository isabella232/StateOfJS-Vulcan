import countries from './countries';
import {
  encrypt,
  cleanupValue,
  normalize,
  normalizeSource,
  getEntities,
  generateEntityRules,
} from './helpers';
import set from 'lodash/set';
import last from 'lodash/last';
import NormalizedResponses from '../../modules/normalized_responses/collection';
import Responses from '../../modules/responses/collection';
import { getSurveyBySlug } from '../../modules/surveys/helpers';
import { logToFile } from 'meteor/vulcan:core';

const replaceAll = function (target, search, replacement) {
  return target.replace(new RegExp(search, 'g'), replacement);
};

const convertForCSV = (obj) => {
  if (!obj || (Array.isArray(obj) && obj.length === 0)) {
    return '';
  } else if (typeof obj === 'string') {
    return obj;
  } else {
    let s = JSON.stringify(obj);
    s = replaceAll(s, '"', `'`);
    // s = replaceAll(s, ',', '\,');
    return s;
  }
};

const logRow = async (columns, fileName) => {
  await logToFile(
    `${fileName}.csv`,
    columns.map((c) => `"${convertForCSV(c)}"`).join(', ')
  );
};

// fields to copy, along with the path at which to copy them (if different)
const fieldsToCopy = [
  ['surveySlug'],
  ['createdAt'],
  ['updatedAt'],
  ['year'],
  ['completion'],
  ['userId'],
  ['isFinished'],
  ['context', 'survey'],
  ['knowledgeScore', 'user_info.knowledge_score'],
  ['common__user_info__device', 'user_info.device'],
  ['common__user_info__browser', 'user_info.browser'],
  ['common__user_info__version', 'user_info.version'],
  ['common__user_info__os', 'user_info.os'],
  ['common__user_info__referrer', 'user_info.referrer'],
  ['common__user_info__source', 'user_info.sourcetag'],
];

export const normalizeResponse = async ({
  document: response,
  entities,
  log = false,
  fileName,
}) => {
  try {
    const normResp = {};
    const normalizedFields = [];
    const survey = getSurveyBySlug(response.surveySlug);
    const allEntities = entities || (await getEntities());
    const allRules = generateEntityRules(allEntities);

    /*
  
    1. Copy over root fields and assign id
    
    */
    fieldsToCopy.forEach((field) => {
      const [fieldName, fieldPath = fieldName] = field;
      set(normResp, fieldPath, response[fieldName]);
    });
    normResp.responseId = response._id;
    normResp.generatedAt = new Date();

    /*
  
    2. Generate email hash
    
    */
    set(normResp, 'user_info.hash', encrypt(response.email));

    /*
  
    3. Store locale
    
    Note: change 'en' to 'en-US' for consistency

    */
    const locale = response.locale === 'en' ? 'en-US' : response.locale;
    set(normResp, 'user_info.locale', locale);

    /*
  
    4. Loop over survey sections and fields (a.k.a. questions)
    
    */
    for (const s of survey.outline) {
      for (const field of s.questions) {
        const { fieldName, matchTags } = field;

        if (!matchTags) {
          throw new Error(`Field ${fieldName} should have matchTags defined`);
        }

        const [initialSegment, ...restOfPath] = fieldName.split('__');
        const normPath = restOfPath.join('.');
        const value = response[fieldName];
        // clean value to eliminate empty spaces, "none", "n/a", etc.
        const cleanValue = cleanupValue(value);

        if (cleanValue) {
          if (last(restOfPath) === 'others') {
            // A. "others" fields needing to be normalized
            set(normResp, `${normPath}.raw`, value);

            if (log) {
              await logToFile(
                `${fileName}.txt`,
                `${
                  response._id
                }, ${fieldName}, ${cleanValue}, ${matchTags.toString()}`
              );
            }
            const normTokens = await normalize(cleanValue, allRules, matchTags);
            // console.log(
            //   `// Normalizing key "${fieldName}" with value "${value}"…`
            // );
            // console.log(
            //   `  -> Normalized values: ${JSON.stringify(normTokens)}`
            // );

            if (log) {
              if (normTokens.length > 0) {
                normTokens.forEach(async (token) => {
                  const { id, pattern, rules, match } = token;
                  await logRow([
                    response._id,
                    fieldName,
                    value,
                    matchTags,
                    id,
                    pattern,
                    rules,
                    match,
                  ], fileName);
                });
              } else {
                await logRow([
                  response._id,
                  fieldName,
                  value,
                  matchTags,
                  'n/a',
                  'n/a',
                  'n/a',
                  'n/a',
                ], fileName);
              }
            }

            // if normalization fails an empty array will be returned
            if (normTokens.length > 0) {
              const normIds = normTokens.map((token) => token.id);
              const normPatterns = normTokens.map((token) =>
                token.pattern.toString()
              );
              set(normResp, `${normPath}.normalized`, normIds);
              set(normResp, `${normPath}.patterns`, normPatterns);
            }
            // keep trace of fields that were normalized
            normalizedFields.push({
              fieldName,
              value,
              normTokens,
            });
          } else if (last(restOfPath) === 'prenormalized') {
            // B. these fields are "prenormalized" through autocomplete inputs
            const newPath = normPath.replace('.prenormalized', '.others');
            set(normResp, `${newPath}.raw`, value);
            set(normResp, `${newPath}.normalized`, value);
            set(normResp, `${newPath}.patterns`, ['prenormalized']);
          } else {
            // C. any other field
            set(normResp, normPath, value);
          }
        }
      }
    }

    /*
  
    5. Normalize country (if provided)
    
    */
    if (normResp.user_info.country) {
      set(normResp, 'user_info.country_alpha2', normResp.user_info.country);
      const countryNormalized = countries.find(
        (c) => c['alpha-2'] === normResp.user_info.country
      );
      if (countryNormalized) {
        set(normResp, 'user_info.country_name', countryNormalized.name);
        set(normResp, 'user_info.country_alpha3', countryNormalized['alpha-3']);
      } else {
        if (log) {
          await logToFile(
            'countries_normalization.txt',
            normResp.user_info.country
          );
        }
      }
    }

    /*
  
    6. Handle source field separately
    
    */
    const normSource = await normalizeSource(normResp, allRules, survey);
    if (normSource) {
      set(normResp, 'user_info.source.raw', normSource.raw);
      set(normResp, 'user_info.source.normalized', normSource.id);
      set(normResp, 'user_info.source.pattern', normSource.pattern.toString());
    }

    // console.log(JSON.stringify(normResp, '', 2));

    let result;
    if (response.normalizedResponseId) {
      // if a normalizedResponse for the current response already exists, update it
      result = NormalizedResponses.update(
        { _id: response.normalizedResponseId },
        normResp
      );
    } else {
      // else, use upsert just for safety (to avoid creating duplicate normalized responses)
      result = NormalizedResponses.upsert(
        { responseId: response._id },
        normResp
      );
      if (result.insertedId) {
        Responses.update(
          { _id: response._id },
          { $set: { normalizedResponseId: result.insertedId } }
        );
      }
    }

    // eslint-disable-next-line
    // console.log(result);
    return { result, normalizedFields };
  } catch (error) {
    console.log('// normalizeResponse error');
    console.log(error);
  }
};
