import uuid from "../utils/uuid";
import {defaultValue, isJsonLogic} from "../utils/stuff";
import {getFieldConfig, extendConfig, normalizeField} from "../utils/configUtils";
import {getWidgetForFieldOp} from "../utils/ruleUtils";
import {loadTree} from "./tree";
import {defaultConjunction, defaultGroupConjunction} from "../utils/defaultUtils";
import moment from "moment";

// http://jsonlogic.com/

// helpers
const arrayUniq = (arr) => Array.from(new Set(arr));
const arrayToObject = (arr) => arr.reduce((acc, [f, fc]) => ({ ...acc, [f]: fc }), {});


export const loadFromJsonLogic = (logicTree, config) => {
  //meta is mutable
  let meta = {
    errors: []
  };
  const extendedConfig = extendConfig(config);
  const conv = buildConv(extendedConfig);
  let jsTree = logicTree ? convertFromLogic(logicTree, conv, extendedConfig, "rule", meta) : undefined;
  if (jsTree && jsTree.type != "group") {
    jsTree = wrapInDefaultConj(jsTree, extendedConfig);
  }
  const immTree = jsTree ? loadTree(jsTree) : undefined;
  if (meta.errors.length)
    console.warn("Errors while importing from JsonLogic:", meta.errors);
  return immTree;
};


const buildConv = (config) => {
  let operators = {};
  for (let opKey in config.operators) {
    const opConfig = config.operators[opKey];
    if (typeof opConfig.jsonLogic == "string") {
      // example: "</2", "#in/1"
      const opk = (opConfig._jsonLogicIsRevArgs ? "#" : "") + opConfig.jsonLogic + "/" + defaultValue(opConfig.cardinality, 1);
      if (!operators[opk])
        operators[opk] = [];
      operators[opk].push(opKey);
    } else if(typeof opConfig.jsonLogic2 == "string") {
      // example: all-in/1"
      const opk = opConfig.jsonLogic2 + "/" + defaultValue(opConfig.cardinality, 1);
      if (!operators[opk])
        operators[opk] = [];
      operators[opk].push(opKey);
    }
  }

  let conjunctions = {};
  for (let conjKey in config.conjunctions) {
    const ck = conjKey.toLowerCase();
    conjunctions[ck] = conjKey;
  }

  let funcs = {};
  for (let funcKey in config.funcs) {
    const funcConfig = config.funcs[funcKey];
    let fk;
    if (funcConfig.jsonLogicIsMethod) {
      fk = "#" + funcConfig.jsonLogic;
    } else if (typeof funcConfig.jsonLogic == "string") {
      fk = funcConfig.jsonLogic;
    }
    if (fk) {
      if (!funcs[fk])
        funcs[fk] = [];
      funcs[fk].push(funcKey);
    }
  }

  return {
    operators,
    conjunctions,
    funcs,
    varKeys: ["var", config.settings.jsonLogic.groupVarKey, config.settings.jsonLogic.altVarKey],
  };
};


const convertFromLogic = (logic, conv, config, expectedType, meta, not = false, fieldConfig, widget, parentField = null) => {
  let op, vals;
  if (isJsonLogic(logic)) {
    op = Object.keys(logic)[0];
    vals = logic[op];
    if (!Array.isArray(vals))
      vals = [ vals ];
  }
  
  let ret;
  let beforeErrorsCnt = meta.errors.length;

  const isEmptyOp = op == "!" && (vals.length == 1 && vals[0] && isJsonLogic(vals[0]) && conv.varKeys.includes(Object.keys(vals[0])[0]));
  const isRev = op == "!" && !isEmptyOp;
  if (isRev) {
    // reverse with not
    ret = convertFromLogic(vals[0], conv, config, expectedType, meta, !not, fieldConfig, widget, parentField);
  } else if(expectedType == "val") {
    // not is not used here
    ret = convertField(op, vals, conv, config, not, meta, parentField) 
      || convertFunc(op, vals, conv, config, not, fieldConfig, meta, parentField) 
      || convertVal(logic, fieldConfig, widget, config, meta);
  } else if(expectedType == "rule") {
    ret = convertConj(op, vals, conv, config, not, meta, parentField) 
    || convertOp(op, vals, conv, config, not, meta, parentField);
  }

  let afterErrorsCnt = meta.errors.length;
  if (op != "!" && ret === undefined && afterErrorsCnt == beforeErrorsCnt) {
    meta.errors.push(`Can't parse logic ${JSON.stringify(logic)}`);
  }

  return ret;
};


const convertVal = (val, fieldConfig, widget, config, meta) => {
  if (val === undefined) return undefined;
  const widgetConfig = config.widgets[widget || fieldConfig.mainWidget];

  if (!widgetConfig) {
    meta.errors.push(`No widget for type ${fieldConfig.type}`);
    return undefined;
  }

  if (isJsonLogic(val)) {
    meta.errors.push(`Unexpected logic in value: ${JSON.stringify(val)}`);
    return undefined;
  }

  // number of seconds -> time string
  if (fieldConfig && fieldConfig.type == "time" && typeof val == "number") {
    const [h, m, s] = [Math.floor(val / 60 / 60) % 24, Math.floor(val / 60) % 60, val % 60];
    const valueFormat = widgetConfig.valueFormat;
    if (valueFormat) {
      const dateVal = new Date(val);
      dateVal.setMilliseconds(0);
      dateVal.setHours(h);
      dateVal.setMinutes(m);
      dateVal.setSeconds(s);
      val = moment(dateVal).format(valueFormat);
    } else {
      val = `${h}:${m}:${s}`;
    }
  }

  // "2020-01-08T22:00:00.000Z" -> Date object
  if (fieldConfig && ["date", "datetime"].includes(fieldConfig.type) && val && !(val instanceof Date)) {
    try {
      const dateVal = new Date(val);
      if (dateVal instanceof Date && dateVal.toISOString() === val) {
        val = dateVal;
      }
    } catch(e) {
      meta.errors.push(`Can't convert value ${val} as Date`);
      val = undefined;
    }
  }

  // Date object -> formatted string
  if (val instanceof Date && fieldConfig) {
    const valueFormat = widgetConfig.valueFormat;
    if (valueFormat) {
      val = moment(val).format(valueFormat);
    }
  }

  let asyncListValues;
  if (val && fieldConfig.fieldSettings && fieldConfig.fieldSettings.asyncFetch) {
    const vals = Array.isArray(val) ? val : [val];
    asyncListValues = vals;
  }

  return {
    valueSrc: "value",
    value: val,
    valueType: widgetConfig.type,
    asyncListValues
  };
};


const convertField = (op, vals, conv, config, not, meta, parentField = null) => {
  const {fieldSeparator} = config.settings;
  if (conv.varKeys.includes(op) && typeof vals[0] == "string") {
    let field = vals[0];
    if (parentField)
      field = [parentField, field].join(fieldSeparator);
    field = normalizeField(config, field);
    const fieldConfig = getFieldConfig(config, field);
    if (!fieldConfig) {
      meta.errors.push(`No config for field ${field}`);
      return undefined;
    }

    return {
      valueSrc: "field",
      value: field,
      valueType: fieldConfig.type,
    };
  }

  return undefined;
};


const convertFunc = (op, vals, conv, config, not, fieldConfig, meta, parentField = null) => {
  if (!op) return undefined;
  let func, argsArr, funcKey;
  const jsonLogicIsMethod = (op == "method");
  if (jsonLogicIsMethod) {
    let obj, opts;
    [obj, func, ...opts] = vals;
    argsArr = [obj, ...opts];
  } else {
    func = op;
    argsArr = vals;
  }

  const fk = (jsonLogicIsMethod ? "#" : "") + func;
  const funcKeys = (conv.funcs[fk] || []).filter(k => 
    (fieldConfig ? config.funcs[k].returnType == fieldConfig.type : true)
  );
  if (funcKeys.length) {
    funcKey = funcKeys[0];
  } else {
    const v = {[op]: vals};
    for (const [f, fc] of Object.entries(config.funcs || {})) {
      if (fc.jsonLogicImport && fc.returnType == fieldConfig.type) {
        let parsed;
        try {
          parsed = fc.jsonLogicImport(v);
        } catch(_e) {
          // given expression `v` can't be parsed into function
        }
        if (parsed) {
          funcKey = f;
          argsArr = parsed;
        }
      }
    }
  }
  if (!funcKey)
    return undefined;

  if (funcKey) {
    const funcConfig = config.funcs[funcKey];
    const argKeys = Object.keys(funcConfig.args || {});
    let args = argsArr.reduce((acc, val, ind) => {
      const argKey = argKeys[ind];
      const argConfig = funcConfig.args[argKey];
      let argVal = convertFromLogic(val, conv, config, "val", meta, false, argConfig, null, parentField);
      if (argVal === undefined) {
        argVal = argConfig.defaultValue;
        if (argVal === undefined) {
          meta.errors.push(`No value for arg ${argKey} of func ${funcKey}`);
          return undefined;
        }
      }
      return {...acc, [argKey]: argVal};
    }, {});

    return {
      valueSrc: "func",
      value: {
        func: funcKey,
        args: args
      },
      valueType: funcConfig.returnType,
    };
  }

  return undefined;
};


const convertConj = (op, vals, conv, config, not, meta, parentField = null) => {
  const conjKey = conv.conjunctions[op];
  const {fieldSeparator} = config.settings;
  if (conjKey) {
    let type = "group";
    const children = vals
      .map(v => convertFromLogic(v, conv, config, "rule", meta, false, null, null, parentField))
      .filter(r => r !== undefined)
      .reduce((acc, r) => ({...acc, [r.id] : r}), {});
    const complexFields = Object.entries(children)
      .filter(([_k, v]) => v.properties !== undefined && v.properties.field !== undefined && v.properties.field.indexOf(fieldSeparator) != -1)
      .map(([_k, v]) => (v.properties.field.split(fieldSeparator)));
    const complexFieldsParents = complexFields
      .map(parts => parts.slice(0, parts.length - 1).join(fieldSeparator));
    const complexFieldsConfigs = arrayToObject(
      arrayUniq(complexFieldsParents).map(f => [f, getFieldConfig(config, f)])
    );
    const complexFieldsInRuleGroup = complexFieldsParents
      .filter((f) => complexFieldsConfigs[f].type == "!group");
    const usedRuleGroups = arrayUniq(complexFieldsInRuleGroup);
    const usedTopRuleGroups = topLevelFieldsFilter(usedRuleGroups);
    
    let properties = {
      conjunction: conjKey,
      not: not
    };
    const id = uuid();

    let children1 = {};
    // TIP: `needSplit` will be true if using mode=struct and there are fields of different groups on one level
    //      (like "a.b" and "x.z" -> need to split them with hierarchy)
    // TIP: Even if fields are of same root parent (like "a.b", "a.c.d"), still we may need to create hierarchy of `rule_group`s
    const needSplit = !(usedTopRuleGroups.length == 1 && complexFieldsInRuleGroup.length == Object.keys(children).length);
    let groupToId = {};
    Object.entries(children).map(([k, v]) => {
      if (v.type == "group" || v.type == "rule_group") {
        // put as-is
        children1[k] = v;
      } else {
        const groupFields = usedRuleGroups.filter((f) => v.properties.field.indexOf(f) == 0);
        const groupField = groupFields.length > 0 ? groupFields.sort((a, b) => (b.length - a.length))[0] : null;
        if (!groupField) {
          // not in rule_group (can be simple field or in struct) - put as-is
          children1[k] = v;
        } else {
          // wrap field in rule_group (with creating hierarchy if need)
          let ch = children1;
          groupField.split(fieldSeparator).map((f, i, a) => {
            const p = a.slice(0, i);
            let ff = [...p, f].join(fieldSeparator);
            ff = normalizeField(config, ff);
            const ffConfig = getFieldConfig(config, ff) || {};
            if (!needSplit && i == 0) {
              type = "rule_group";
              properties.field = ff;
              properties.mode = ffConfig.mode;
              groupToId[ff] = id;
            } else {
              let groupId = groupToId[ff];
              if (!groupId) {
                groupId = uuid();
                groupToId[ff] = groupId;
                ch[groupId] = {
                  type: "rule_group",
                  id: groupId,
                  children1: {},
                  properties: {
                    conjunction: conjKey,
                    not: false,
                    field: ff,
                    mode: ffConfig.mode,
                  }
                };
              }
              ch = ch[groupId].children1;
            }
          });
          ch[k] = v;
        }
      }
    });

    return {
      type: type,
      id: id,
      children1: children1,
      properties: properties
    };
  }

  return undefined;
};


const topLevelFieldsFilter = (fields) => {
  let arr = [...fields].sort((a, b) => (a.length - b.length));
  for (let i = 0 ; i < arr.length ; i++) {
    for (let j = i + 1 ; j < arr.length ; j++) {
      if (arr[j].indexOf(arr[i]) == 0) {
        // arr[j] is inside arr[i] (eg. "a.b" inside "a")
        arr.splice(j, 1);
        j--;
      }
    }
  }
  return arr;
};

const wrapInDefaultConjRuleGroup = (rule, parentField, parentFieldConfig, config, conj) => {
  if (!rule) return undefined;
  return {
    type: "rule_group",
    id: uuid(),
    children1: { [rule.id]: rule },
    properties: {
      conjunction: conj || defaultGroupConjunction(config, parentFieldConfig),
      not: false,
      field: parentField,
    }
  };
};

const wrapInDefaultConj = (rule, config, not = false) => {
  return {
    type: "group",
    id: uuid(),
    children1: { [rule.id]: rule },
    properties: {
      conjunction: defaultConjunction(config),
      not: not
    }
  };
};

const parseRule = (op, arity, vals, parentField, conv, config, meta) => {
  let errors = [];
  let res = _parseRule(op, arity, vals, parentField, conv, config, errors, false) 
         || _parseRule(op, arity, vals, parentField, conv, config, errors, true) ;

  if (!res) {
    meta.errors.push(errors.join("; ") || `Unknown op ${op}/${arity}`);
    return undefined;
  }
  
  return res;
};

const _parseRule = (op, arity, vals, parentField, conv, config, errors, isRevArgs) => {
  // config.settings.groupOperators are used for group count (cardinality = 0 is exception)
  // but don't confuse with "all-in" for multiselect
  const isAllInForMultiselect = op == "all" && isJsonLogic(vals[1]) && Object.keys(vals[1])[0] == "in";
  const isGroup0 = !isAllInForMultiselect && config.settings.groupOperators.includes(op);
  const cardinality = isGroup0 ? 0 : arity - 1;

  const opk = op + "/" + cardinality;
  const {fieldSeparator} = config.settings;
  let opKeys = conv.operators[(isRevArgs ? "#" : "") + opk];
  if (opKeys) {
    let jlField, args = [];
    const rangeOps = ["<", "<=", ">", ">="];
    if (rangeOps.includes(op) && arity == 3) {
      jlField = vals[1];
      args = [ vals[0], vals[2] ];
    } else if (isRevArgs) {
      jlField = vals[1];
      args = [ vals[0] ];
    } else {
      [jlField, ...args] = vals;
    }

    if (!isJsonLogic(jlField)) {
      errors.push(`Incorrect operands for ${op}: ${JSON.stringify(vals)}`);
      return;
    }
    let k = Object.keys(jlField)[0];
    let v = Object.values(jlField)[0];
    
    let field, having, isGroup;
    if (conv.varKeys.includes(k) && typeof v == "string") {
      field = v;
    }
    if (isGroup0) {
      isGroup = true;
      having = args[0];
      args = [];
    }
    // reduce/filter for group ext
    if (k == "reduce" && Array.isArray(v) && v.length == 3) {
      let [filter, acc, init] = v;
      if (isJsonLogic(filter) && init == 0 && isJsonLogic(acc) && Array.isArray(acc["+"]) && acc["+"][0] == 1 && isJsonLogic(acc["+"][1]) && acc["+"][1]["var"] == "accumulator") {
        k = Object.keys(filter)[0];
        v = Object.values(filter)[0];
        if (k == "filter") {
          let [group, filter] = v;
          if (isJsonLogic(group)) {
            k = Object.keys(group)[0];
            v = Object.values(group)[0];
            if (conv.varKeys.includes(k) && typeof v == "string") {
              field = v;
              having = filter;
              isGroup = true;
            }
          }
        } else if (conv.varKeys.includes(k) && typeof v == "string") {
          field = v;
          isGroup = true;
        }
      }
    }
    
    if (!field) {
      errors.push(`Unknown field ${JSON.stringify(jlField)}`);
      return;
    }
    if (parentField)
      field = [parentField, field].join(fieldSeparator);
    field = normalizeField(config, field);

    const fieldConfig = getFieldConfig(config, field);
    if (!fieldConfig) {
      errors.push(`No config for field ${field}`);
      return;
    }

    let opKey = opKeys[0];
    if (opKeys.length > 1 && fieldConfig && fieldConfig.operators) {
      // eg. for "equal" and "select_equals"
      opKeys = opKeys
        .filter(k => fieldConfig.operators.includes(k));
      if (opKeys.length == 0) {
        errors.push(`No corresponding ops for field ${field}`);
        return;
      }
      opKey = opKeys[0];
    }
    
    return {
      field, fieldConfig, opKey, args, having
    };
  }
};


const convertOp = (op, vals, conv, config, not, meta, parentField = null) => {
  if (!op) return undefined;

  const arity = vals.length;
  if (op == "all" && isJsonLogic(vals[1])) {
    // special case for "all-in"
    const op2 = Object.keys(vals[1])[0];
    if (op2 == "in") {
      vals = [
        vals[0],
        vals[1][op2][1]
      ];
      op = op + "-" + op2; // "all-in"
    }
  }

  const parseRes = parseRule(op, arity, vals, parentField, conv, config, meta);
  if (!parseRes) return undefined;
  let {field, fieldConfig, opKey, args, having} = parseRes;
  let opConfig = config.operators[opKey];

  // Group component in array mode can show NOT checkbox, so do nothing in this case
  // Otherwise try to revert
  const showNot = fieldConfig.showNot !== undefined ? fieldConfig.showNot : config.settings.showNot; 
  let canRev = true;
  if (fieldConfig.type == "!group" && fieldConfig.mode == "array" && showNot)
    canRev = false;

  // Fix "some ! in"
  if (fieldConfig.type == "!group" && having && Object.keys(having)[0] == "!") {
    not = !not;
    having = having["!"];
  }

  // Use reversed op
  if (not && canRev && opConfig.reversedOp) {
    not = false;
    opKey = opConfig.reversedOp;
    opConfig = config.operators[opKey];
  }

  const widget = getWidgetForFieldOp(config, field, opKey);

  const convertedArgs = args
    .map(v => convertFromLogic(v, conv, config, "val", meta, false, fieldConfig, widget, parentField));
  if (convertedArgs.filter(v => v === undefined).length) {
    //meta.errors.push(`Undefined arg for field ${field} and op ${opKey}`);
    return undefined;
  }

  let res;

  if (fieldConfig.type == "!group" && having) {
    const conj = Object.keys(having)[0];
    const havingVals = having[conj];
    const _not = false;

    if (conv.conjunctions[conj] !== undefined) {
      res = convertConj(conj, havingVals, conv, config, _not, meta, field);
    } else {
      // need to be wrapped in `rule_group`
      const rule = convertOp(conj, havingVals, conv, config, _not, meta, field);
      res = wrapInDefaultConjRuleGroup(rule, field, fieldConfig, config, conv.conjunctions["and"]);
    }
    Object.assign(res.properties, {
      mode: fieldConfig.mode,
      not: (canRev ? false : not),
      operator: opKey,
    });
    if (fieldConfig.mode == "array") {
      Object.assign(res.properties, {
        value: convertedArgs.map(v => v.value),
        valueSrc: convertedArgs.map(v => v.valueSrc),
        valueType: convertedArgs.map(v => v.valueType),
      });
    }
  } else if (fieldConfig.type == "!group" && !having) {
    res = {
      type: "rule_group",
      id: uuid(),
      children1: {},
      properties: {
        conjunction: defaultGroupConjunction(config, fieldConfig),
        not: (canRev ? false : not),
        mode: fieldConfig.mode,
        field: field,
        operator: opKey,
      }
    };
    if (fieldConfig.mode == "array") {
      Object.assign(res.properties, {
        value: convertedArgs.map(v => v.value),
        valueSrc: convertedArgs.map(v => v.valueSrc),
        valueType: convertedArgs.map(v => v.valueType),
      });
    }
  } else {
    const asyncListValuesArr = convertedArgs.map(v => v.asyncListValues).filter(v => v != undefined);
    const asyncListValues = asyncListValuesArr.length ? asyncListValuesArr[0] : undefined;
    res = {
      type: "rule",
      id: uuid(),
      properties: {
        field: field,
        operator: opKey,
        value: convertedArgs.map(v => v.value),
        valueSrc: convertedArgs.map(v => v.valueSrc),
        valueType: convertedArgs.map(v => v.valueType),
        asyncListValues,
      }
    };
  }

  if (not && canRev) {
    //meta.errors.push(`No rev op for ${opKey}`);
    res = wrapInDefaultConj(res, config, not);
  }

  return res;
};

