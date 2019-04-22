import { writeFileSync } from 'fs';
import * as ts from 'typescript';

class Stats {
    public knownTypes = 0;
    public percentage = 100;
    public totalTypes = 0;

    public gap() {
        return this.totalTypes - this.knownTypes;
    }

    public done() {
        this.percentage = this.totalTypes === 0 ? 100 : (100 * this.knownTypes) / this.totalTypes;
    }
}

interface IReport {
    files: IPerSourceFileReport[];
    stats: Stats;
}

function initReport(): IReport {
    return {
        files: [],
        stats: new Stats(),
    };
}

function finalizeReport(report: IReport) {
    report.stats.done();

    // prioritize files by the coverage gap, showing worst first
    report.files.sort((a, b) => b.stats.gap() - a.stats.gap());
}

function finalizeFile(report: IReport, perFile?: IPerSourceFileReport) {
    if (perFile) {
        perFile.stats.done();
        report.stats.totalTypes += perFile.stats.totalTypes;
        report.stats.knownTypes += perFile.stats.knownTypes;

        if (perFile.incidents.length > 0) {
            report.files.push(perFile);
        }
    }
}

interface Incident {
    end: number;
    name: string;
    start: number;
    text: string;
}

interface IPerSourceFileReport {
    filename: string;
    incidents: Incident[];
    stats: Stats;
}

function initPerFileReport(filename: string): IPerSourceFileReport {
    return {
        filename,
        incidents: [],
        stats: new Stats(),
    };
}

export function typeCoverage(program: ts.Program, coverageFile?: string) {
    const checker = program.getTypeChecker();

    const result = new Stats();

    function visit(
        node: ts.Node,
        idents?: IPerSourceFileReport,
        params?: IPerSourceFileReport,
        rets?: IPerSourceFileReport,
    ) {
        if (
            ts.isIdentifier(node) &&
            (!node.parent ||
                (!ts.isFunctionDeclaration(node.parent) &&
                    !ts.isClassDeclaration(node.parent) &&
                    !(
                        ts.isVariableDeclaration(node.parent) &&
                        node.parent.parent &&
                        ts.isCatchClause(node.parent.parent)
                    )))
        ) {
            let type: ts.Type = checker.getTypeAtLocation(node);
            if (type) {
                let isAny = checker.typeToString(type) === 'any';
                if (isAny && node.parent && ts.isImportSpecifier(node.parent)) {
                    const symbol = checker.getSymbolAtLocation(node.parent.name);
                    if (symbol) {
                        const maybe = checker.getDeclaredTypeOfSymbol(symbol);
                        if (maybe) {
                            type = maybe;
                            isAny = checker.typeToString(type) === 'any';
                        }
                    }
                }

                result.totalTypes++;
                if (idents) {
                    idents.stats.totalTypes++;
                }
                if (!isAny) {
                    result.knownTypes++;
                    if (idents) {
                        idents.stats.knownTypes++;
                    }
                } else if (idents) {
                    idents.incidents.push({
                        end: node.getEnd(),
                        name: node.escapedText.toString(),
                        start: node.getFullStart(),
                        text: node.getText().substring(0, 40),
                    });
                }
            }
        } else if (
            rets &&
            (ts.isMethodDeclaration(node) ||
                ts.isFunctionDeclaration(node) ||
                ts.isArrowFunction(node) ||
                ts.isFunctionExpression(node))
        ) {
            const decl = node as ts.SignatureDeclaration;
            const sig = checker.getSignatureFromDeclaration(decl);
            if (sig) {
                const returnType = checker.getReturnTypeOfSignature(sig);
                if (returnType) {
                    rets.stats.totalTypes++;
                    if (checker.typeToString(returnType) !== 'any') {
                        rets.stats.knownTypes++;
                    } else {
                        const name =
                            decl.name && ts.isIdentifier(decl.name) ? decl.name.escapedText.toString() : 'unknown';
                        rets.incidents.push({
                            end: decl.getEnd(),
                            name,
                            start: decl.getFullStart(),
                            text: decl.getText().substring(0, 40),
                        });
                    }
                }
            }
        } else if (params && ts.isParameter(node)) {
            const parameter = node as ts.ParameterDeclaration;
            const type = parameter.type;
            if (type) {
                params.stats.totalTypes++;
                if (checker.typeToString(checker.getTypeFromTypeNode(type)) !== 'any') {
                    params.stats.knownTypes++;
                } else {
                    const name = ts.isIdentifier(parameter.name) ? parameter.name.escapedText.toString() : 'unknown';
                    params.incidents.push({
                        end: parameter.getEnd(),
                        name,
                        start: parameter.getFullStart(),
                        text: parameter.getText(),
                    });
                }
            } else {
                params.stats.totalTypes++;
                const inferredType = checker.getTypeAtLocation(parameter);
                if (inferredType && checker.typeToString(inferredType) !== 'any') {
                    params.stats.knownTypes++;
                } else {
                    const name = ts.isIdentifier(parameter.name) ? parameter.name.escapedText.toString() : 'unknown';
                    params.incidents.push({
                        end: parameter.getEnd(),
                        name,
                        start: parameter.getFullStart(),
                        text: parameter.getText(),
                    });
                }
            }
        }
        node.forEachChild((_) => visit(_, idents, params, rets));
    }

    const identifiers = initReport();
    const declarations = initReport();
    const parameters = initReport();
    const returns = initReport();

    for (const filename of program.getRootFileNames()) {
        const sourceFile = program.getSourceFile(filename);
        if (sourceFile && !sourceFile.isDeclarationFile) {
            const idents = coverageFile ? initPerFileReport(filename) : undefined;
            const params = coverageFile ? initPerFileReport(filename) : undefined;
            const rets = coverageFile ? initPerFileReport(filename) : undefined;

            visit(sourceFile, idents, params, rets);

            finalizeFile(identifiers, idents);
            finalizeFile(parameters, params);
            finalizeFile(returns, rets);
        }
    }

    finalizeReport(identifiers);
    finalizeReport(declarations);
    finalizeReport(parameters);
    finalizeReport(returns);
    result.done();

    if (coverageFile) {
        writeFileSync(
            coverageFile,
            JSON.stringify(
                {
                    breakdowns: {
                        declarations,
                        identifiers,
                        parameters,
                        returns,
                    },
                    stats: result,
                },
                undefined,
                2,
            ),
        );
    }

    return result;
}
