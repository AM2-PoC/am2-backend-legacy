const isSpace = (ch) => /\s/.test(ch);

const skipQuoted = (source, start) => {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '\\') i += 2;
    else if (source[i] === quote) return i + 1;
    else i += 1;
  }
  throw new Error(`unterminated string at offset ${start}`);
};

const skipTrivia = (source, start) => {
  let i = start;
  while (i < source.length) {
    if (isSpace(source[i])) { i += 1; continue; }
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) throw new Error(`unterminated comment at offset ${i}`);
      i = end + 2;
      continue;
    }
    break;
  }
  return i;
};

const matching = { '(': ')', '<': '>', '[': ']', '{': '}' };

const findMatching = (source, start) => {
  const open = source[start];
  const close = matching[open];
  if (!close) throw new Error(`unsupported delimiter ${open} at offset ${start}`);
  const stack = [close];
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '"' || source[i] === '\'') { i = skipQuoted(source, i); continue; }
    if (source.startsWith('//', i) || source.startsWith('/*', i)) { i = skipTrivia(source, i); continue; }
    if (matching[source[i]]) stack.push(matching[source[i]]);
    else if (source[i] === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return i;
    }
    i += 1;
  }
  throw new Error(`unclosed ${open} at offset ${start}`);
};

const splitTopLevel = (source, separator = ',') => {
  const parts = [];
  let start = 0;
  const stack = [];
  let i = 0;
  while (i < source.length) {
    if (source[i] === '"' || source[i] === '\'') { i = skipQuoted(source, i); continue; }
    if (source.startsWith('//', i) || source.startsWith('/*', i)) { i = skipTrivia(source, i); continue; }
    if (matching[source[i]]) stack.push(matching[source[i]]);
    else if (stack.length && source[i] === stack.at(-1)) stack.pop();
    else if (source[i] === separator && stack.length === 0) {
      parts.push(source.slice(start, i).trim());
      start = i + 1;
    }
    i += 1;
  }
  const tail = source.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
};

const decodeKotlinString = (literal) => JSON.parse(literal);

const parseLiteralDefault = (parameter) => {
  const parts = splitTopLevel(parameter, '=');
  if (parts.length === 1) return undefined;
  if (parts.length !== 2) throw new Error(`unparseable default: ${parameter}`);
  const value = parts[1].trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) return decodeKotlinString(value);
  if (/^(?:true|false)$/.test(value)) return value === 'true';
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value === 'null') return null;
  throw new Error(`unsupported non-literal default: ${value}`);
};

const parseParameter = (parameter, functionName) => {
  const match = parameter.match(/@(Query|Field|Part)\s*(?:\(\s*("(?:[^"\\]|\\.)*")\s*\))?/s);
  if (!match) throw new Error(`${functionName}: unclassified Retrofit parameter: ${parameter}`);
  const annotationEnd = match.index + match[0].length;
  const declaration = parameter.slice(annotationEnd).trim();
  const nameMatch = declaration.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
  if (!nameMatch) throw new Error(`${functionName}: missing parameter name: ${parameter}`);
  const parsed = {
    kind: match[1].toLowerCase(),
    name: match[2] ? decodeKotlinString(match[2]) : nameMatch[1],
  };
  const defaultValue = parseLiteralDefault(parameter);
  if (defaultValue !== undefined) parsed.default = defaultValue;
  return parsed;
};

const normalizeType = (value) => value.replace(/\s+/g, '');

const maskNonCode = (source) => {
  const chars = [...source];
  let i = 0;
  while (i < source.length) {
    let end = i;
    if (source[i] === '"' || source[i] === '\'') end = skipQuoted(source, i);
    else if (source.startsWith('//', i) || source.startsWith('/*', i)) end = skipTrivia(source, i);
    if (end > i) {
      for (let j = i; j < end; j += 1) {
        if (source[j] !== '\n') chars[j] = ' ';
      }
      i = end;
    } else i += 1;
  }
  return chars.join('');
};

export function parseRetrofitInterface(source) {
  const methods = [];
  const code = maskNonCode(source);
  for (const annotation of code.matchAll(/@(PUT|PATCH|DELETE|HEAD|OPTIONS|HTTP)\b/g)) {
    throw new Error(`unsupported Retrofit HTTP annotation @${annotation[1]}`);
  }
  const endpoint = /@(GET|POST)\s*\(\s*("(?:[^"\\]|\\.)*")\s*\)/g;
  const supportedPositions = new Set();
  let match;
  while ((match = endpoint.exec(source)) !== null) {
    if (code[match.index] !== '@') continue;
    supportedPositions.add(match.index);
    const nextGet = code.slice(endpoint.lastIndex).search(/@GET\s*\(/);
    const nextPost = code.slice(endpoint.lastIndex).search(/@POST\s*\(/);
    const nextEndpoint = [nextGet, nextPost].filter((offset) => offset !== -1).sort((a, b) => a - b)[0] ?? -1;
    const searchEnd = nextEndpoint === -1 ? source.length : endpoint.lastIndex + nextEndpoint;
    const segment = code.slice(endpoint.lastIndex, searchEnd);
    const functionMatch = segment.match(/\bsuspend\s+fun\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (!functionMatch) throw new Error(`endpoint ${decodeKotlinString(match[2])} has no suspend function`);
    const functionName = functionMatch[1];
    const absoluteFunction = endpoint.lastIndex + functionMatch.index;
    const openParameters = source.indexOf('(', absoluteFunction + functionMatch[0].indexOf('('));
    const closeParameters = findMatching(source, openParameters);
    const rawParameters = source.slice(openParameters + 1, closeParameters);
    const afterParameters = skipTrivia(source, closeParameters + 1);
    if (source[afterParameters] !== ':') throw new Error(`${functionName}: missing return type`);
    const returnStart = skipTrivia(source, afterParameters + 1);
    if (!source.startsWith('Response', returnStart)) throw new Error(`${functionName}: return type is not Response`);
    const genericStart = skipTrivia(source, returnStart + 'Response'.length);
    if (source[genericStart] !== '<') throw new Error(`${functionName}: Response has no generic type`);
    const genericEnd = findMatching(source, genericStart);
    const parameters = splitTopLevel(rawParameters).map((parameter) => parseParameter(parameter, functionName));
    const parameterKinds = new Set(parameters.map((parameter) => parameter.kind));
    if (parameterKinds.has('part') && parameterKinds.has('field')) {
      throw new Error(`${functionName}: mixed multipart and form fields`);
    }
    const previousEndpoint = code.slice(0, match.index).lastIndexOf('@GET(') > code.slice(0, match.index).lastIndexOf('@POST(')
      ? code.slice(0, match.index).lastIndexOf('@GET(')
      : code.slice(0, match.index).lastIndexOf('@POST(');
    const preludeStart = previousEndpoint === -1 ? Math.max(0, code.lastIndexOf('{', match.index) + 1) : previousEndpoint;
    const prelude = code.slice(preludeStart, match.index);
    const multipart = /@Multipart\b/.test(prelude);
    const form = /@FormUrlEncoded\b/.test(prelude);
    if (multipart && form) throw new Error(`${functionName}: conflicting Retrofit encodings`);
    const encoding = multipart ? 'multipart' : form ? 'form' : 'query';
    if (parameterKinds.has('part') !== multipart || parameterKinds.has('field') !== form) {
      throw new Error(`${functionName}: parameter annotations do not match @${multipart ? 'Multipart' : form ? 'FormUrlEncoded' : 'GET'} encoding`);
    }
    methods.push({
      function: functionName,
      http_method: match[1],
      path: decodeKotlinString(match[2]),
      encoding,
      parameters,
      response_type: normalizeType(source.slice(genericStart + 1, genericEnd)),
    });
    endpoint.lastIndex = genericEnd + 1;
  }
  for (const annotation of code.matchAll(/@(GET|POST)\b/g)) {
    if (!supportedPositions.has(annotation.index)) {
      throw new Error(`unsupported Retrofit HTTP annotation @${annotation[1]}`);
    }
  }
  if (methods.length === 0) throw new Error('no Retrofit endpoints found');
  const names = methods.map((method) => method.function);
  if (new Set(names).size !== names.length) throw new Error('duplicate Retrofit function name');
  return methods;
}
