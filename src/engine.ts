/**
 * Takes a full query and a set of indices, and (hopefully quickly) returns all relevant files.
 */
import { LiteralField, LiteralFieldRepr, Query, Fields, Source, NamedField } from 'src/query';
import { FullIndex } from 'src/index';
import { Task } from 'src/file';
import { DateTime } from 'luxon';
import { TFile } from 'obsidian';
import { Context, BINARY_OPS, LinkHandler } from 'src/eval';

/** The result of executing a query over an index. */
export interface QueryResult {
    /** The names of the resulting fields. */
    names: string[];
    /** The actual data rows returned. */
    data: LiteralField[][];
}

/** Recursively collect target files from the given source. */
export function collectFromSource(source: Source, index: FullIndex, origin: string): Set<string> | string {
    switch (source.type) {
        case "empty": return new Set<string>();
        case "tag": return index.tags.getInverse(source.tag);
        case "folder": return index.prefix.get(source.folder);
        case "link":
            let fullPath = index.metadataCache.getFirstLinkpathDest(source.file, origin)?.path;
            if (!fullPath) return `Could not resolve link "${source.file}" during link lookup - does it exist?`;

            if (source.direction === 'incoming') {
                // To find all incoming links (i.e., things that link to this), use the index that Obsidian provides.
                // TODO: Use an actual index so this isn't a fullscan.
                let resolved = index.metadataCache.resolvedLinks;
                let incoming = new Set<string>();

                for (let [key, value] of Object.entries(resolved)) {
                    if (fullPath in value) incoming.add(key);
                }

                return incoming;
            } else {
                let resolved = index.metadataCache.resolvedLinks;
                if (!(fullPath in resolved)) return `Could not find file "${source.file}" during link lookup - does it exist?`;

                return new Set<string>(Object.keys(index.metadataCache.resolvedLinks[fullPath]));
            }
        case "binaryop":
            let left = collectFromSource(source.left, index, origin);
            if (typeof left === 'string') return left;
            let right = collectFromSource(source.right, index, origin);
            if (typeof right === 'string') return right;

            if (source.op == '&') {
                let result = new Set<string>();
                for (let elem of right) {
                    if (left.has(elem)) result.add(elem);
                }

                return result;
            } else if (source.op == '|') {
                let result = new Set(left);
                for (let elem of right) result.add(elem);
                return result;
            } else {
                return `Unrecognized operator '${source.op}'.`;
            }
        case "negate":
            let child = collectFromSource(source.child, index, origin);
            if (typeof child === 'string') return child;

            // TODO: This is obviously very inefficient.
            let allFiles = new Set<string>(index.vault.getMarkdownFiles().map(f => f.path));

            for (let file of child) {
                allFiles.delete(file);
            }

            return allFiles;
    }
}

/** The default link resolver used when creating contexts. */
export function defaultLinkHandler(index: FullIndex, origin: string): LinkHandler {
    return {
        resolve: (link) => {
            let realFile = index.metadataCache.getFirstLinkpathDest(link, origin);
            if (!realFile) return Fields.NULL;

            let context = createContext(realFile.path, index);
            if (context) return context.namespace;
            else return Fields.NULL;
        },
        normalize: (link) => {
            let realFile = index.metadataCache.getFirstLinkpathDest(link, origin);
            return realFile?.path ?? link;
        },
        exists: (link) => {
            let realFile = index.metadataCache.getFirstLinkpathDest(link, origin);
            return !!realFile;
        }
    }
}

/** Create a fully-filled context representing the given file. */
export function createContext(file: string, index: FullIndex, rootContext: Context | undefined = undefined): Context | undefined {
    let page = index.pages.get(file);
    if (!page) return undefined;

    // Create a context which uses the cache to look up link info.
    let context = new Context(defaultLinkHandler(index, file), rootContext, Fields.object(page.fields));

    // Fill out per-file metadata.
    let fileMeta = new Map<string, LiteralField>();
    fileMeta.set("path", Fields.string(file));
    fileMeta.set("folder", Fields.string(page.folder()));
    fileMeta.set("name", Fields.string(page.name()));
    fileMeta.set("link", Fields.link(file));
    fileMeta.set("tags", Fields.array(Array.from(page.fullTags()).map(l => Fields.string(l))));
    fileMeta.set("etags", Fields.array(Array.from(page.tags).map(l => Fields.string(l))));
    fileMeta.set("aliases", Fields.array(Array.from(page.aliases).map(l => Fields.string(l))));

    if (page.day) fileMeta.set("day", Fields.date(page.day));

    // Populate file metadata.
    let afile = index.vault.getAbstractFileByPath(file);
    if (afile && afile instanceof TFile) {
        let ctime = DateTime.fromMillis(afile.stat.ctime);
        let mtime = DateTime.fromMillis(afile.stat.mtime);

        fileMeta.set('ctime', Fields.date(ctime));
        fileMeta.set('cday', Fields.date(DateTime.fromObject({ year: ctime.year, month: ctime.month, day: ctime.day })));
        fileMeta.set('mtime', Fields.date(mtime));
        fileMeta.set('mday', Fields.date(DateTime.fromObject({ year: mtime.year, month: mtime.month, day: mtime.day })));
        fileMeta.set('size', Fields.number(afile.stat.size));
        fileMeta.set('ext', Fields.string(afile.extension));
    }

    context.set("file", Fields.object(fileMeta));

    return context;
}

/** Execute a query over the given index, returning all matching rows. */
export function execute(query: Query, index: FullIndex, origin: string): QueryResult | string {
    // Start by collecting all of the files that match the 'from' queries.
    let fileset = collectFromSource(query.source, index, origin);
    if (typeof fileset === 'string') return fileset;

    let rootContext = new Context(defaultLinkHandler(index, origin));

    // Collect file metadata about the file this query is running in.
    if (origin) {
        let context = createContext(origin, index);
        if (context) rootContext.set("this", context.namespace);
    }

    // Then, map all of the files to their corresponding contexts.
    let rows: Context[] = [];
    for (let file of fileset) {
        let context = createContext(file, index, rootContext);
        if (context) rows.push(context);
    }

    for (let operation of query.operations) {
        switch (operation.type) {
            case "limit":
                let amount = rootContext.evaluate(operation.amount);
                if (typeof amount == 'string') return amount;
                if (amount.valueType != 'number') return `LIMIT clauses requires a number - got ${amount.valueType} (value ${amount.value})`;
                
                if (rows.length > amount.value) rows = rows.slice(0, amount.value);
                break;
            case "where":
                let predicate = operation.clause;
                rows = rows.filter(row => {
                    let value = row.evaluate(predicate);
                    if (typeof value == 'string') return false;
                    return Fields.isTruthy(value);
                });
                break;
            case "sort":
                let sortFields = operation.fields;
                // Sort rows by the sort fields, and then return the finished result.
                rows.sort((a, b) => {
                    for (let index = 0; index < sortFields.length; index++) {
                        let factor = sortFields[index].direction === 'ascending' ? 1 : -1;

                        let aValue = a.evaluate(sortFields[index].field);
                        if (typeof aValue == 'string') return 1;
                        let bValue = b.evaluate(sortFields[index].field);
                        if (typeof bValue == 'string') return -1;

                        let le = BINARY_OPS.evaluate('<', aValue, bValue, a) as LiteralFieldRepr<'boolean'>;
                        if (le.value) return factor * -1;

                        let ge = BINARY_OPS.evaluate('>', aValue, bValue, a) as LiteralFieldRepr<'boolean'>;
                        if (ge.value) return factor * 1;
                    }

                    return 0;
                });
                break;
            case "flatten":
                let flattenField = operation.field;
                let newRows: Context[] = [];
                for (let row of rows) {
                    let value = row.evaluate(flattenField.field);
                    if (typeof value == "string") continue;

                    if (value.valueType == "array") {
                        for (let newValue of value.value) {
                            newRows.push(row.copy().set(flattenField.name, newValue));
                        }
                    } else {
                        newRows.push(row);
                        continue;
                    }
                }

                rows = newRows;
                break;
            case "group":
                let groupField = operation.field;
                let groupIndex: Map<string, [LiteralField, Context[]]> = new Map();
                for (let row of rows) {
                    let value = row.evaluate(groupField.field);
                    if (typeof value == 'string') continue; // TODO: Maybe put in an '<error>' group?

                    let key = Fields.toLiteralKey(value);
                    if (!groupIndex.has(key)) groupIndex.set(key, [value, []]);

                    groupIndex.get(key)?.[1].push(row);
                }

                let groupedRows: Context[] = [];
                for (let [_, value] of groupIndex.entries()) {
                    // We are gaurunteed to have at least 1 object since the key was created.
                    let dummyFile = value[1][0].evaluate(Fields.indexVariable("file.path")) as LiteralFieldRepr<'string'>;

                    // Create a context, assign the grouped field and the 'rows'.
                    let context = new Context(defaultLinkHandler(index, dummyFile.value), rootContext);
                    context.set(groupField.name, value[0]);
                    context.set("rows", Fields.array(value[1].map(c => c.namespace)));

                    // This is a hack because I have a file association per-row, which breaks down in group queries.
                    context.set("file", Fields.object(new Map<string, LiteralField>().set("path", dummyFile)));
                    groupedRows.push(context);
                }

                rows = groupedRows;
                break;
        }
    }

    let hasFileLinks = rows.some(ctx => {
        let field = ctx.evaluate(Fields.indexVariable("file.link"))
        if (typeof field == "string") return false;
        return field.valueType == "link";
    });

    switch (query.header.type) {
        case "table":
            let tableFields = query.header.fields;
            if (hasFileLinks) tableFields.unshift(Fields.named("File", Fields.indexVariable("file.link")));

            return {
                names: tableFields.map(v => v.name),
                data: rows.map(row => {
                    return tableFields.map(f => {
                        let value = row.evaluate(f.field);
                        if (typeof value == "string") return Fields.NULL;
                        return value;
                    })
                })
            };
        case "list":
            let format = query.header.format;

            let listFields: NamedField[] = [];
            if (hasFileLinks) listFields.push(Fields.named("File", Fields.indexVariable("file.link")));
            if (format) listFields.push(Fields.named("Value", format));

            return {
                names: listFields.map(v => v.name),
                data: rows.map(row => {
                    return listFields.map(f => {
                        let value = row.evaluate(f.field);
                        if (typeof value == "string") return Fields.NULL;
                        return value;
                    })
                })
            };
        case "task":
            let filtered: LiteralField[][] = [];
            for (let row of rows) {
                let file = row.evaluate(Fields.indexVariable("file.path"));
                if (typeof file == "string") continue;
                filtered.push([file]);
            }

            return {
                names: ["file"],
                data: filtered
            }
    }
}

export function executeTask(query: Query, origin: string, index: FullIndex): Map<string, Task[]> | string {
    // This is a somewhat silly way to do this for now; call into regular execute on the full query,
    // yielding a list of files. Then map the files to their tasks.
    // TODO: Consider per-task or per-task-block filtering via a more nuanced algorithm.
    let result = execute(query, index, origin);
    if (typeof result === 'string') return result;

    let realResult = new Map<string, Task[]>();
    for (let row of result.data) {
        let file = (row[0] as LiteralFieldRepr<'string'>).value;

        let tasks = index.pages.get(file)?.tasks;
        if (tasks == undefined || tasks.length == 0) continue;

        realResult.set(file, tasks);
    }

    return realResult;
}